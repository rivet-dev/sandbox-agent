import { logInspectorUrl, runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

export async function setupNetlifySandboxAgent(netlifyUrl?: string): Promise<{
  baseUrl: string;
  token?: string;
  cleanup: () => Promise<void>;
}> {
  // Use provided URL or try to detect from environment
  let baseUrl: string;
  
  if (netlifyUrl) {
    baseUrl = netlifyUrl;
  } else if (process.env.NETLIFY_URL) {
    baseUrl = process.env.NETLIFY_URL;
  } else if (process.env.URL) {
    baseUrl = process.env.URL;
  } else {
    throw new Error(
      "Netlify URL not found. Please provide it as a parameter or set NETLIFY_URL environment variable."
    );
  }

  // Ensure URL has protocol
  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  console.log(`Connecting to Netlify deployment at: ${baseUrl}`);

  // Wait for the Netlify function to initialize the sandbox-agent server
  // This might take a while on cold start
  console.log("Waiting for sandbox-agent to initialize (this may take up to 2 minutes on cold start)...");
  await waitForHealth({ baseUrl, timeoutMs: 120000 }); // 2 minute timeout for cold start

  console.log("✅ Sandbox agent is ready!");

  // For Netlify, cleanup is not needed since functions are stateless
  const cleanup = async () => {
    console.log("Netlify functions are stateless - no cleanup needed");
  };

  return { baseUrl, cleanup };
}

// Run interactively if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  // Check for required environment variables  
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY or ANTHROPIC_API_KEY required");
  }

  // Get the Netlify URL from command line argument or environment
  const netlifyUrl = process.argv[2] || process.env.NETLIFY_URL;
  if (!netlifyUrl) {
    console.error("Usage: npm start <netlify-url>");
    console.error("Or set NETLIFY_URL environment variable");
    process.exit(1);
  }

  const { baseUrl, cleanup } = await setupNetlifySandboxAgent(netlifyUrl);
  logInspectorUrl({ baseUrl });

  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  // When running on Netlify, permission prompts may need auto-approval
  // depending on the serverless function timeout constraints
  await runPrompt({
    baseUrl,
    autoApprovePermissions: process.env.AUTO_APPROVE_PERMISSIONS === "true",
  });
  
  await cleanup();
}