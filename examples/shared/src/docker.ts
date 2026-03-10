import Docker from "dockerode";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { waitForHealth } from "./sandbox-agent-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_IMAGE = "sandbox-agent-examples:latest";
const EXAMPLE_IMAGE_DEV = "sandbox-agent-examples-dev:latest";
const DOCKERFILE_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DOCKERFILE_DIR, "../..");

export interface DockerSandboxOptions {
  /** Container port used by sandbox-agent inside Docker. */
  port: number;
  /** Optional fixed host port mapping. If omitted, Docker assigns a free host port automatically. */
  hostPort?: number;
  /** Additional shell commands to run before starting sandbox-agent. */
  setupCommands?: string[];
  /** Docker image to use. Defaults to the pre-built sandbox-agent-examples image. */
  image?: string;
}

export interface DockerSandbox {
  baseUrl: string;
  cleanup: () => Promise<void>;
}

const DIRECT_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENCODE_API_KEY",
] as const;

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseExtractedCredentials(output: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const cleanLine = line.startsWith("export ") ? line.slice(7) : line;
    const match = cleanLine.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = stripShellQuotes(rawValue);
    if (!value) continue;
    parsed[key] = value;
  }
  return parsed;
}

interface ClaudeCredentialFile {
  hostPath: string;
  containerPath: string;
  base64Content: string;
}

function readClaudeCredentialFiles(): ClaudeCredentialFile[] {
  const homeDir = process.env.HOME || "";
  if (!homeDir) return [];

  const candidates: Array<{ hostPath: string; containerPath: string }> = [
    {
      hostPath: path.join(homeDir, ".claude", ".credentials.json"),
      containerPath: "/root/.claude/.credentials.json",
    },
    {
      hostPath: path.join(homeDir, ".claude-oauth-credentials.json"),
      containerPath: "/root/.claude-oauth-credentials.json",
    },
  ];

  const files: ClaudeCredentialFile[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.hostPath)) continue;
    try {
      const raw = fs.readFileSync(candidate.hostPath, "utf8");
      files.push({
        hostPath: candidate.hostPath,
        containerPath: candidate.containerPath,
        base64Content: Buffer.from(raw, "utf8").toString("base64"),
      });
    } catch {
      // Ignore unreadable credential file candidates.
    }
  }
  return files;
}

function collectCredentialEnv(): Record<string, string> {
  const merged: Record<string, string> = {};
  let extracted: Record<string, string> = {};
  try {
    const output = execFileSync(
      "sandbox-agent",
      ["credentials", "extract-env"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    extracted = parseExtractedCredentials(output);
  } catch {
    // Fall back to direct env vars if extraction is unavailable.
  }

  for (const [key, value] of Object.entries(extracted)) {
    if (value) merged[key] = value;
  }
  for (const key of DIRECT_CREDENTIAL_KEYS) {
    const direct = process.env[key];
    if (direct) merged[key] = direct;
  }
  return merged;
}

function shellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function stripAnsi(value: string): string {
  return value.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><])/g,
    "",
  );
}

async function ensureExampleImage(_docker: Docker): Promise<string> {
  const dev = !!process.env.SANDBOX_AGENT_DEV;
  const imageName = dev ? EXAMPLE_IMAGE_DEV : EXAMPLE_IMAGE;

  if (dev) {
    console.log("  Building sandbox image from source (may take a while, only runs once)...");
    try {
      execFileSync("docker", [
        "build", "-t", imageName,
        "-f", path.join(DOCKERFILE_DIR, "Dockerfile.dev"),
        REPO_ROOT,
      ], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err: unknown) {
      const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
      throw new Error(`Failed to build sandbox image: ${stderr}`);
    }
  } else {
    console.log("  Building sandbox image (may take a while, only runs once)...");
    try {
      execFileSync("docker", ["build", "-t", imageName, DOCKERFILE_DIR], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err: unknown) {
      const stderr = err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
      throw new Error(`Failed to build sandbox image: ${stderr}`);
    }
  }

  return imageName;
}

/**
 * Start a Docker container running sandbox-agent and wait for it to be healthy.
 * Registers SIGINT/SIGTERM handlers for cleanup.
 */
export async function startDockerSandbox(opts: DockerSandboxOptions): Promise<DockerSandbox> {
  const { port, hostPort } = opts;
  const useCustomImage = !!opts.image;
  let image = opts.image ?? EXAMPLE_IMAGE;
  // TODO: Replace setupCommands shell bootstrapping with native sandbox-agent exec API once available.
  const setupCommands = [...(opts.setupCommands ?? [])];
  const credentialEnv = collectCredentialEnv();
  const claudeCredentialFiles = readClaudeCredentialFiles();
  const bootstrapEnv: Record<string, string> = {};

  if (claudeCredentialFiles.length > 0) {
    delete credentialEnv.ANTHROPIC_API_KEY;
    delete credentialEnv.CLAUDE_API_KEY;
    delete credentialEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete credentialEnv.ANTHROPIC_AUTH_TOKEN;

    const credentialBootstrapCommands = claudeCredentialFiles.flatMap((file, index) => {
      const envKey = `SANDBOX_AGENT_CLAUDE_CREDENTIAL_${index}_B64`;
      bootstrapEnv[envKey] = file.base64Content;
      return [
        `mkdir -p ${shellSingleQuotedLiteral(path.posix.dirname(file.containerPath))}`,
        `printf %s "$${envKey}" | base64 -d > ${shellSingleQuotedLiteral(file.containerPath)}`,
      ];
    });
    setupCommands.unshift(...credentialBootstrapCommands);
  }

  for (const [key, value] of Object.entries(credentialEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }

  const docker = new Docker({ socketPath: "/var/run/docker.sock" });

  if (useCustomImage) {
    try {
      await docker.getImage(image).inspect();
    } catch {
      console.log(`  Pulling ${image}...`);
      await new Promise<void>((resolve, reject) => {
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
        });
      });
    }
  } else {
    image = await ensureExampleImage(docker);
  }

  const bootCommands = [
    ...setupCommands,
    `sandbox-agent server --no-token --host 0.0.0.0 --port ${port}`,
  ];

  const container = await docker.createContainer({
    Image: image,
    WorkingDir: "/root",
    Cmd: ["sh", "-c", bootCommands.join(" && ")],
    Env: [
      ...Object.entries(credentialEnv).map(([key, value]) => `${key}=${value}`),
      ...Object.entries(bootstrapEnv).map(([key, value]) => `${key}=${value}`),
    ],
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { [`${port}/tcp`]: [{ HostPort: hostPort ? `${hostPort}` : "0" }] },
    },
  });
  await container.start();

  const logChunks: string[] = [];
  const startupLogs = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    since: 0,
  }) as NodeJS.ReadableStream;
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  stdoutStream.on("data", (chunk) => {
    logChunks.push(stripAnsi(String(chunk)));
  });
  stderrStream.on("data", (chunk) => {
    logChunks.push(stripAnsi(String(chunk)));
  });
  docker.modem.demuxStream(startupLogs, stdoutStream, stderrStream);
  const stopStartupLogs = () => {
    const stream = startupLogs as NodeJS.ReadableStream & { destroy?: () => void };
    try { stream.destroy?.(); } catch {}
  };

  const inspect = await container.inspect();
  const mappedPorts = inspect.NetworkSettings?.Ports?.[`${port}/tcp`];
  const mappedHostPort = mappedPorts?.[0]?.HostPort;
  if (!mappedHostPort) {
    throw new Error(`Failed to resolve mapped host port for container port ${port}`);
  }
  const baseUrl = `http://127.0.0.1:${mappedHostPort}`;

  try {
    await waitForHealth({ baseUrl });
  } catch (err) {
    stopStartupLogs();
    console.error("  Container logs:");
    for (const chunk of logChunks) {
      process.stderr.write(`    ${chunk}`);
    }
    throw err;
  }
  stopStartupLogs();
  console.log(`  Ready (${baseUrl})`);

  const cleanup = async () => {
    stopStartupLogs();
    try { await container.stop({ t: 5 }); } catch {}
    try { await container.remove({ force: true }); } catch {}
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  return { baseUrl, cleanup };
}
