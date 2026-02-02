import { getSandbox, proxyToSandbox, type Sandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Proxy requests to exposed ports first
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const { hostname } = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, "sandbox-agent");

    console.log("Installing sandbox-agent...");
    await sandbox.exec(
      "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh"
    );

    console.log("Installing agents...");
    await sandbox.exec("sandbox-agent install-agent claude");
    await sandbox.exec("sandbox-agent install-agent codex");

    // Set environment variables for agents
    const envVars: Record<string, string> = {};
    if (env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
    await sandbox.setEnvVars(envVars);

    console.log("Starting sandbox-agent server...");
    await sandbox.startProcess(
      "sandbox-agent server --no-token --host 0.0.0.0 --port 8000"
    );

    // Wait for server to start
    await new Promise((r) => setTimeout(r, 2000));

    // Expose the port with a preview URL
    const exposed = await sandbox.exposePort(8000, { hostname });

    console.log("Server accessible at:", exposed.url);

    return Response.json({
      endpoint: exposed.url,
      message: "sandbox-agent server is running",
    });
  },
};
