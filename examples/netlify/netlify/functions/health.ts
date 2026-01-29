import { Handler } from "@netlify/functions";

/**
 * Simple health check endpoint for the Netlify deployment
 * This can be used for uptime monitoring without triggering the main function
 */
const handler: Handler = async (event, context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
      "cache-control": "max-age=60",
    },
    body: JSON.stringify({
      status: "ok",
      service: "netlify-sandbox-agent",
      timestamp: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      },
    }),
  };
};

export { handler };