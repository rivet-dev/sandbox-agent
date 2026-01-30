import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { promises as fs } from "fs";
import { existsSync } from "fs";

// Global variable to store the server process
let serverProcess: ChildProcess | null = null;
let serverReady = false;
let serverPort = 3000;
let isInstalling = false; // Prevent concurrent installations

// Install sandbox-agent if not present
async function installSandboxAgent(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("Installing sandbox-agent...");
    const installProcess = spawn("sh", ["-c", "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh"], {
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    if (installProcess.stdout) {
      installProcess.stdout.on("data", (data) => {
        stdout += data.toString();
        console.log("Install output:", data.toString());
      });
    }

    if (installProcess.stderr) {
      installProcess.stderr.on("data", (data) => {
        stderr += data.toString();
        console.error("Install error:", data.toString());
      });
    }

    installProcess.on("close", async (code) => {
      if (code === 0) {
        console.log("sandbox-agent installed successfully");
        // Verify installation by checking if binary exists
        try {
          await verifyInstallation();
          resolve();
        } catch (error) {
          reject(new Error(`Installation verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
        }
      } else {
        reject(new Error(`Installation failed with code ${code}. Stderr: ${stderr}`));
      }
    });

    // Add timeout for installation
    setTimeout(() => {
      installProcess.kill();
      reject(new Error("Installation timed out after 60 seconds"));
    }, 60000);
  });
}

// Verify sandbox-agent is properly installed and accessible
async function verifyInstallation(): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkProcess = spawn("sandbox-agent", ["--version"], { 
      stdio: "pipe",
      env: { ...process.env, PATH: `/tmp/.sandbox-agent:${process.env.PATH}` } // Add common install location to PATH
    });
    
    let stdout = "";
    let stderr = "";
    
    if (checkProcess.stdout) {
      checkProcess.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }
    
    if (checkProcess.stderr) {
      checkProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });
    }
    
    checkProcess.on("close", (code) => {
      if (code === 0) {
        console.log("sandbox-agent verification successful:", stdout.trim());
        resolve();
      } else {
        reject(new Error(`sandbox-agent verification failed with code ${code}. Stderr: ${stderr}`));
      }
    });
    
    setTimeout(() => {
      checkProcess.kill();
      reject(new Error("Verification timed out"));
    }, 10000);
  });
}

// Install agents
async function installAgents(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("Installing agents...");
    const installAgentsProcess = spawn("sandbox-agent", ["install-agent", "claude"], {
      stdio: "pipe",
      env: { ...process.env, PATH: `/tmp/.sandbox-agent:${process.env.PATH}` }
    });

    let stdout = "";
    let stderr = "";

    if (installAgentsProcess.stdout) {
      installAgentsProcess.stdout.on("data", (data) => {
        stdout += data.toString();
        console.log("Agent install output:", data.toString());
      });
    }

    if (installAgentsProcess.stderr) {
      installAgentsProcess.stderr.on("data", (data) => {
        stderr += data.toString();
        console.error("Agent install error:", data.toString());
      });
    }

    installAgentsProcess.on("close", async (code) => {
      if (code === 0) {
        // Install codex agent too
        const installCodexProcess = spawn("sandbox-agent", ["install-agent", "codex"], {
          stdio: "pipe",
          env: { ...process.env, PATH: `/tmp/.sandbox-agent:${process.env.PATH}` }
        });
        
        let codexStderr = "";
        
        if (installCodexProcess.stderr) {
          installCodexProcess.stderr.on("data", (data) => {
            codexStderr += data.toString();
            console.error("Codex install error:", data.toString());
          });
        }
        
        if (installCodexProcess.stdout) {
          installCodexProcess.stdout.on("data", (data) => {
            console.log("Codex install output:", data.toString());
          });
        }
        
        installCodexProcess.on("close", (codeCodex) => {
          if (codeCodex === 0) {
            console.log("Agents installed successfully");
            resolve();
          } else {
            reject(new Error(`Codex installation failed with code ${codeCodex}. Stderr: ${codexStderr}`));
          }
        });
      } else {
        reject(new Error(`Claude installation failed with code ${code}. Stderr: ${stderr}`));
      }
    });
  });
}

// Cleanup server process
function cleanupServer(): void {
  if (serverProcess && !serverProcess.killed) {
    console.log("Cleaning up server process...");
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }, 5000);
  }
  serverProcess = null;
  serverReady = false;
}

// Start the sandbox-agent server
async function startSandboxAgent(): Promise<void> {
  if (serverProcess && !serverProcess.killed && serverReady) {
    console.log("Server already running and ready");
    return;
  }

  // Cleanup any existing process
  if (serverProcess && !serverProcess.killed) {
    cleanupServer();
  }

  return new Promise((resolve, reject) => {
    console.log("Starting sandbox-agent server...");
    
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      PATH: `/tmp/.sandbox-agent:${process.env.PATH}`, // Ensure binary is in PATH
    };

    serverProcess = spawn("sandbox-agent", ["server", "--no-token", "--host", "0.0.0.0", "--port", serverPort.toString()], {
      stdio: "pipe",
      env,
    });

    let output = "";
    let hasResolved = false;
    
    if (serverProcess.stdout) {
      serverProcess.stdout.on("data", (data) => {
        output += data.toString();
        console.log("Server output:", data.toString());
        if ((output.includes("Server started") || output.includes("listening")) && !hasResolved) {
          serverReady = true;
          hasResolved = true;
          resolve();
        }
      });
    }

    if (serverProcess.stderr) {
      serverProcess.stderr.on("data", (data) => {
        console.error("Server error:", data.toString());
      });
    }

    serverProcess.on("close", (code) => {
      console.log(`Server process exited with code ${code}`);
      if (code !== 0 && serverReady) {
        // Only treat as error if server was previously ready (unexpected exit)
        serverReady = false;
        serverProcess = null;
      } else if (code !== 0 && !hasResolved) {
        // Server failed to start initially
        serverReady = false;
        serverProcess = null;
        reject(new Error(`Server failed to start with code ${code}`));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!hasResolved) {
        cleanupServer();
        reject(new Error("Server failed to start within 30 seconds"));
      }
    }, 30000);
  });
}

// Check if server is healthy
async function checkServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // Increased to 2s for better reliability
    
    const response = await fetch(`http://localhost:${serverPort}/health`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    console.log("Health check failed:", error instanceof Error ? error.message : "Unknown error");
    return false;
  }
}

// Check if sandbox-agent is already installed
async function isSandboxAgentInstalled(): Promise<boolean> {
  try {
    await new Promise((resolve, reject) => {
      const checkProcess = spawn("sandbox-agent", ["--version"], { 
        stdio: "pipe",
        env: { ...process.env, PATH: `/tmp/.sandbox-agent:${process.env.PATH}` }
      });
      checkProcess.on("close", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`sandbox-agent not found`));
      });
      setTimeout(() => {
        checkProcess.kill();
        reject(new Error("Check timed out"));
      }, 5000);
    });
    return true;
  } catch {
    return false;
  }
}

// Main handler function
const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const { httpMethod, path, body, headers } = event;
  
  // Set up cleanup on function timeout
  const cleanupTimeout = setTimeout(() => {
    console.log("Function timeout approaching, cleaning up...");
    cleanupServer();
  }, 9500); // Cleanup just before Netlify's 10s timeout

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };

  // Handle preflight requests
  if (httpMethod === "OPTIONS") {
    clearTimeout(cleanupTimeout);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  try {
    // Check if we need to install/start sandbox-agent
    if (!serverReady || !(await checkServerHealth())) {
      console.log("Server not ready, setting up...");
      
      // Prevent concurrent installations
      if (isInstalling) {
        clearTimeout(cleanupTimeout);
        return {
          statusCode: 503,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "Server is initializing",
            message: "Please try again in a few moments",
          }),
        };
      }
      
      try {
        isInstalling = true;
        
        // Check if sandbox-agent is installed, install if not
        if (!(await isSandboxAgentInstalled())) {
          await installSandboxAgent();
          await installAgents();
        }
        
        await startSandboxAgent();
        
        // Wait for server to be ready (reduced timeout for Netlify limits)
        let attempts = 0;
        while (attempts < 10 && !(await checkServerHealth())) {
          await new Promise((r) => setTimeout(r, 500));
          attempts++;
        }
        
        if (!(await checkServerHealth())) {
          throw new Error("Server failed to become healthy");
        }
      } catch (error) {
        console.error("Failed to setup sandbox-agent:", error);
        clearTimeout(cleanupTimeout);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "Failed to setup sandbox-agent",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
        };
      } finally {
        isInstalling = false;
      }
    }

    // Proxy the request to the local sandbox-agent server
    const targetUrl = `http://localhost:${serverPort}${path || ""}`;
    const queryString = event.queryStringParameters 
      ? new URLSearchParams(event.queryStringParameters as Record<string, string>).toString()
      : "";
    const fullUrl = queryString ? `${targetUrl}?${queryString}` : targetUrl;

    const proxyHeaders: Record<string, string> = {};
    
    // Forward relevant headers
    const forwardHeaders = ["content-type", "authorization", "accept", "user-agent"];
    forwardHeaders.forEach((header) => {
      if (headers[header]) {
        proxyHeaders[header] = headers[header];
      }
    });

    console.log(`Proxying ${httpMethod} ${fullUrl}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout (within Netlify's 10s limit)
    
    try {
      const response = await fetch(fullUrl, {
        method: httpMethod,
        headers: proxyHeaders,
        body: body && httpMethod !== "GET" && httpMethod !== "HEAD" ? body : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      clearTimeout(cleanupTimeout);

      const contentType = response.headers.get("content-type") || "application/json";
      const responseBody = await response.text();
      
      return {
        statusCode: response.status,
        headers: {
          ...corsHeaders,
          "content-type": contentType,
        },
        body: responseBody,
      };
    } finally {
      clearTimeout(timeoutId);
    }

  } catch (error) {
    console.error("Handler error:", error);
    clearTimeout(cleanupTimeout);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};

export { handler };