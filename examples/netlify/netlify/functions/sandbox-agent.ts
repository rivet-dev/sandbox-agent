import { Handler, HandlerEvent, HandlerContext } from "@netlify/functions";
import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { promises as fs } from "fs";
import { existsSync } from "fs";

// Global variable to store the server process
let serverProcess: ChildProcess | null = null;
let serverReady = false;
let serverPort = 3000;

// Install sandbox-agent if not present
async function installSandboxAgent(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("Installing sandbox-agent...");
    const installProcess = spawn("sh", ["-c", "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh"], {
      stdio: "inherit",
    });

    installProcess.on("close", (code) => {
      if (code === 0) {
        console.log("sandbox-agent installed successfully");
        resolve();
      } else {
        reject(new Error(`Installation failed with code ${code}`));
      }
    });
  });
}

// Install agents
async function installAgents(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("Installing agents...");
    const installAgentsProcess = spawn("sandbox-agent", ["install-agent", "claude"], {
      stdio: "inherit",
    });

    installAgentsProcess.on("close", async (code) => {
      if (code === 0) {
        // Install codex agent too
        const installCodexProcess = spawn("sandbox-agent", ["install-agent", "codex"], {
          stdio: "inherit",
        });
        
        installCodexProcess.on("close", (codeCodex) => {
          if (codeCodex === 0) {
            console.log("Agents installed successfully");
            resolve();
          } else {
            reject(new Error(`Codex installation failed with code ${codeCodex}`));
          }
        });
      } else {
        reject(new Error(`Claude installation failed with code ${code}`));
      }
    });
  });
}

// Start the sandbox-agent server
async function startSandboxAgent(): Promise<void> {
  if (serverProcess && !serverProcess.killed) {
    console.log("Server already running");
    return;
  }

  return new Promise((resolve, reject) => {
    console.log("Starting sandbox-agent server...");
    
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };

    serverProcess = spawn("sandbox-agent", ["server", "--no-token", "--host", "0.0.0.0", "--port", serverPort.toString()], {
      stdio: "pipe",
      env,
    });

    let output = "";
    
    if (serverProcess.stdout) {
      serverProcess.stdout.on("data", (data) => {
        output += data.toString();
        console.log("Server output:", data.toString());
        if (output.includes("Server started") || output.includes("listening")) {
          serverReady = true;
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
      serverReady = false;
      console.log(`Server process exited with code ${code}`);
      if (code !== 0 && !serverReady) {
        reject(new Error(`Server failed to start with code ${code}`));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!serverReady) {
        reject(new Error("Server failed to start within 30 seconds"));
      }
    }, 30000);
  });
}

// Check if server is healthy
async function checkServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1000);
    
    const response = await fetch(`http://localhost:${serverPort}/health`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

// Check if sandbox-agent is already installed
async function isSandboxAgentInstalled(): Promise<boolean> {
  try {
    await new Promise((resolve, reject) => {
      const checkProcess = spawn("sandbox-agent", ["--version"], { stdio: "pipe" });
      checkProcess.on("close", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`sandbox-agent not found`));
      });
    });
    return true;
  } catch {
    return false;
  }
}

// Main handler function
const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const { httpMethod, path, body, headers } = event;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };

  // Handle preflight requests
  if (httpMethod === "OPTIONS") {
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
      
      try {
        // Check if sandbox-agent is installed, install if not
        if (!(await isSandboxAgentInstalled())) {
          await installSandboxAgent();
          await installAgents();
        }
        
        await startSandboxAgent();
        
        // Wait for server to be ready
        let attempts = 0;
        while (attempts < 30 && !(await checkServerHealth())) {
          await new Promise((r) => setTimeout(r, 1000));
          attempts++;
        }
        
        if (!(await checkServerHealth())) {
          throw new Error("Server failed to become healthy");
        }
      } catch (error) {
        console.error("Failed to setup sandbox-agent:", error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "Failed to setup sandbox-agent",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
        };
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
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 second timeout
    
    try {
      const response = await fetch(fullUrl, {
        method: httpMethod,
        headers: proxyHeaders,
        body: body && httpMethod !== "GET" && httpMethod !== "HEAD" ? body : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

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