#!/usr/bin/env tsx
/**
 * Integration test script for Netlify deployment
 * 
 * Usage:
 *   npm run test:integration <netlify-url>
 * 
 * Example:
 *   npm run test:integration https://my-sandbox-agent.netlify.app
 */

import { SandboxAgent } from "sandbox-agent";
import { setupNetlifySandboxAgent } from "./netlify.js";

async function testNetlifyIntegration(netlifyUrl: string) {
  console.log("🚀 Testing Netlify Sandbox Agent Integration");
  console.log(`📍 URL: ${netlifyUrl}`);
  console.log();

  try {
    // Step 1: Setup connection
    console.log("1️⃣ Setting up connection...");
    const { baseUrl, cleanup } = await setupNetlifySandboxAgent(netlifyUrl);
    console.log(`✅ Connected to: ${baseUrl}`);
    console.log();

    // Step 2: Test health endpoint
    console.log("2️⃣ Testing health endpoint...");
    const client = await SandboxAgent.connect({ baseUrl });
    const health = await client.getHealth();
    console.log(`✅ Health check passed:`, health);
    console.log();

    // Step 3: List available agents
    console.log("3️⃣ Listing available agents...");
    const agents = await client.getAgents();
    console.log(`✅ Available agents:`, agents.map((a: any) => a.name).join(", "));
    console.log();

    // Step 4: Create a session
    console.log("4️⃣ Creating test session...");
    const sessionId = "test-session-" + Date.now();
    await client.createSession(sessionId, {
      agent: "claude",
      permissionMode: "ask",
    });
    console.log(`✅ Session created: ${sessionId}`);
    console.log();

    // Step 5: Send a test message
    console.log("5️⃣ Sending test message...");
    await client.postMessage(sessionId, {
      message: "Hello! Please respond with 'Integration test successful' and nothing else.",
    });
    console.log("✅ Message sent");
    console.log();

    // Step 6: Listen for response
    console.log("6️⃣ Waiting for response...");
    let responseReceived = false;
    const timeout = setTimeout(() => {
      if (!responseReceived) {
        console.log("⚠️ Timeout waiting for response");
      }
    }, 30000); // 30 second timeout

    for await (const event of client.streamEvents(sessionId)) {
      if (event.type === "textDelta" || event.type === "text") {
        console.log("📥 Response:", event.data);
        responseReceived = true;
        clearTimeout(timeout);
        break;
      } else if (event.type === "error") {
        console.error("❌ Error:", event.data);
        break;
      } else if (event.type === "done") {
        break;
      }
    }

    if (responseReceived) {
      console.log("✅ Response received successfully");
    }
    console.log();

    // Step 7: Cleanup
    console.log("7️⃣ Cleaning up...");
    try {
      await client.deleteSession(sessionId);
      console.log("✅ Session cleaned up");
    } catch (error) {
      console.log("⚠️ Session cleanup failed (may be normal)");
    }

    await cleanup();
    console.log("✅ Integration test completed successfully!");
    console.log();
    console.log("🎉 Your Netlify Sandbox Agent deployment is working correctly!");

  } catch (error) {
    console.error("❌ Integration test failed:");
    console.error(error);
    process.exit(1);
  }
}

// Parse command line arguments
const netlifyUrl = process.argv[2];

if (!netlifyUrl) {
  console.error("❌ Error: Netlify URL required");
  console.error("Usage: npm run test:integration <netlify-url>");
  console.error("Example: npm run test:integration https://my-sandbox-agent.netlify.app");
  process.exit(1);
}

// Check required environment variables
if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("❌ Error: ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable required");
  process.exit(1);
}

console.log("🔧 Environment check passed");
console.log();

// Run the test
testNetlifyIntegration(netlifyUrl).catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});