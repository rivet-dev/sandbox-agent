#!/usr/bin/env npx tsx
/**
 * Sandbox Testing Script
 *
 * Tests sandbox-agent on various cloud sandbox providers.
 * Usage: npx tsx test-sandbox.ts [provider] [options]
 *
 * Providers: daytona, e2b, docker
 *
 * Options:
 *   --skip-build          Skip cargo build step
 *   --use-release         Use pre-built release binary from releases.rivet.dev
 *   --agent <name>        Test specific agent (claude, codex, mock)
 *   --skip-agent-install  Skip pre-installing agents (tests on-demand install like Daytona example)
 *   --keep-alive          Don't cleanup sandbox after test
 *   --verbose             Show all logs
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const SERVER_DIR = join(ROOT_DIR, "server");

// Parse args
const args = process.argv.slice(2);
const provider = args.find((a) => !a.startsWith("--")) || "docker";
const skipBuild = args.includes("--skip-build");
const useRelease = args.includes("--use-release");
const skipAgentInstall = args.includes("--skip-agent-install");
const keepAlive = args.includes("--keep-alive");
const verbose = args.includes("--verbose");
const agentArg = args.find((a) => a.startsWith("--agent="))?.split("=")[1];

// Colors
const log = {
	info: (msg: string) => console.log(`\x1b[34m[INFO]\x1b[0m ${msg}`),
	success: (msg: string) => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`),
	error: (msg: string) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
	warn: (msg: string) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
	debug: (msg: string) => verbose && console.log(`\x1b[90m[DEBUG]\x1b[0m ${msg}`),
	section: (msg: string) => console.log(`\n\x1b[1m=== ${msg} ===\x1b[0m`),
};

// Credentials extraction (mirrors agent-credentials logic)
function getAnthropicApiKey(): string | undefined {
	if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
	const home = homedir();
	for (const path of [join(home, ".claude.json"), join(home, ".claude.json.api")]) {
		try {
			const data = JSON.parse(readFileSync(path, "utf-8"));
			const key = data.primaryApiKey || data.apiKey || data.anthropicApiKey;
			if (key?.startsWith("sk-ant-")) return key;
		} catch {}
	}
	return undefined;
}

function getOpenAiApiKey(): string | undefined {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	const home = homedir();
	try {
		const data = JSON.parse(readFileSync(join(home, ".codex", "codex.json"), "utf-8"));
		if (data.apiKey) return data.apiKey;
	} catch {}
	return undefined;
}

// Build sandbox-agent
async function buildSandboxAgent(): Promise<string> {
	log.section("Building sandbox-agent");

	if (useRelease) {
		log.info("Using pre-built release from releases.rivet.dev");
		return "RELEASE";
	}

	// Binary is in workspace root target dir, not server target dir
	const binaryPath = join(ROOT_DIR, "target/release/sandbox-agent");

	if (skipBuild) {
		if (!existsSync(binaryPath)) {
			throw new Error(`Binary not found at ${binaryPath}. Run without --skip-build.`);
		}
		log.info(`Using existing binary: ${binaryPath}`);
		return binaryPath;
	}

	log.info("Running cargo build --release...");
	try {
		execSync("cargo build --release -p sandbox-agent", {
			cwd: ROOT_DIR,
			stdio: verbose ? "inherit" : "pipe",
		});
		log.success(`Built: ${binaryPath}`);
		return binaryPath;
	} catch (err) {
		throw new Error(`Build failed: ${err}`);
	}
}

// Provider interface
interface SandboxProvider {
	name: string;
	requiredEnv: string[];
	create(opts: { envVars: Record<string, string> }): Promise<Sandbox>;
}

interface Sandbox {
	id: string;
	exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
	upload(localPath: string, remotePath: string): Promise<void>;
	getBaseUrl(port: number): Promise<string>;
	cleanup(): Promise<void>;
}

// Docker provider
// Uses Ubuntu because Claude Code and sandbox-agent are glibc binaries
const dockerProvider: SandboxProvider = {
	name: "docker",
	requiredEnv: [],
	async create({ envVars }) {
		const id = `sandbox-test-${Date.now()}`;
		const envArgs = Object.entries(envVars)
			.map(([k, v]) => `-e ${k}=${v}`)
			.join(" ");

		log.info(`Creating Docker container: ${id}`);
		execSync(
			`docker run -d --name ${id} ${envArgs} -p 0:3000 ubuntu:22.04 tail -f /dev/null`,
			{ stdio: verbose ? "inherit" : "pipe" },
		);

		// Install dependencies
		execSync(`docker exec ${id} sh -c "apt-get update && apt-get install -y curl ca-certificates"`, {
			stdio: verbose ? "inherit" : "pipe",
		});

		return {
			id,
			async exec(cmd) {
				try {
					const stdout = execSync(`docker exec ${id} sh -c "${cmd.replace(/"/g, '\\"')}"`, {
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "pipe"],
					});
					return { stdout, stderr: "", exitCode: 0 };
				} catch (err: any) {
					return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status || 1 };
				}
			},
			async upload(localPath, remotePath) {
				execSync(`docker cp "${localPath}" ${id}:${remotePath}`, { stdio: verbose ? "inherit" : "pipe" });
				execSync(`docker exec ${id} chmod +x ${remotePath}`, { stdio: verbose ? "inherit" : "pipe" });
			},
			async getBaseUrl(port) {
				const portMapping = execSync(`docker port ${id} ${port}`, { encoding: "utf-8" }).trim();
				const hostPort = portMapping.split(":").pop();
				return `http://localhost:${hostPort}`;
			},
			async cleanup() {
				log.info(`Cleaning up container: ${id}`);
				execSync(`docker rm -f ${id}`, { stdio: "pipe" });
			},
		};
	},
};

// Daytona provider
const daytonaProvider: SandboxProvider = {
	name: "daytona",
	requiredEnv: ["DAYTONA_API_KEY"],
	async create({ envVars }) {
		const { Daytona } = await import("@daytonaio/sdk");
		const daytona = new Daytona();

		log.info("Creating Daytona sandbox...");
		// NOTE: Tier 1/2 sandboxes have restricted network that cannot be overridden
		// networkAllowList requires CIDR notation (IP ranges), not domain names
		const sandbox = await daytona.create({
			image: "ubuntu:22.04",
			envVars,
		});
		const id = sandbox.id;

		// Install curl
		await sandbox.process.executeCommand("apt-get update && apt-get install -y curl ca-certificates");

		return {
			id,
			async exec(cmd) {
				const result = await sandbox.process.executeCommand(cmd);
				// Daytona SDK returns: { exitCode, result: string, artifacts: { stdout: string } }
				return {
					stdout: result.result || "",
					stderr: "",
					exitCode: result.exitCode ?? 0,
				};
			},
			async upload(localPath, remotePath) {
				const content = readFileSync(localPath);
				// Daytona SDK signature: uploadFile(Buffer, remotePath)
				await sandbox.fs.uploadFile(content, remotePath);
				await sandbox.process.executeCommand(`chmod +x ${remotePath}`);
			},
			async getBaseUrl(port) {
				const preview = await sandbox.getSignedPreviewUrl(port, 4 * 60 * 60);
				return preview.url;
			},
			async cleanup() {
				log.info(`Cleaning up Daytona sandbox: ${id}`);
				await sandbox.delete(60);
			},
		};
	},
};

// E2B provider
const e2bProvider: SandboxProvider = {
	name: "e2b",
	requiredEnv: ["E2B_API_KEY"],
	async create({ envVars }) {
		const { Sandbox } = await import("@e2b/code-interpreter");

		log.info("Creating E2B sandbox...");
		let sandbox;
		try {
			sandbox = await Sandbox.create({
				allowInternetAccess: true,
				envs: envVars,
			});
		} catch (err: any) {
			log.error(`E2B sandbox creation failed: ${err.message || err}`);
			throw err;
		}
		const id = sandbox.sandboxId;

		// Install curl (E2B uses Debian which has glibc, sandbox-agent will auto-detect)
		const installResult = await sandbox.commands.run(
			"sudo apt-get update && sudo apt-get install -y curl ca-certificates"
		);
		log.debug(`Install output: ${installResult.stdout} ${installResult.stderr}`);

		return {
			id,
			async exec(cmd) {
				const result = await sandbox.commands.run(cmd);
				return {
					stdout: result.stdout || "",
					stderr: result.stderr || "",
					exitCode: result.exitCode,
				};
			},
			async upload(localPath, remotePath) {
				const content = readFileSync(localPath);
				await sandbox.files.write(remotePath, content);
				await sandbox.commands.run(`chmod +x ${remotePath}`);
			},
			async getBaseUrl(port) {
				return `https://${sandbox.getHost(port)}`;
			},
			async cleanup() {
				log.info(`Cleaning up E2B sandbox: ${id}`);
				await sandbox.kill();
			},
		};
	},
};

// Get provider
function getProvider(name: string): SandboxProvider {
	switch (name) {
		case "docker":
			return dockerProvider;
		case "daytona":
			return daytonaProvider;
		case "e2b":
			return e2bProvider;
		default:
			throw new Error(`Unknown provider: ${name}. Available: docker, daytona, e2b`);
	}
}

// Install sandbox-agent in sandbox
async function installSandboxAgent(sandbox: Sandbox, binaryPath: string): Promise<void> {
	log.section("Installing sandbox-agent");

	if (binaryPath === "RELEASE") {
		log.info("Installing from releases.rivet.dev...");
		const result = await sandbox.exec(
			"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
		);
		log.debug(`Install output: ${result.stdout}`);
		if (result.exitCode !== 0) {
			throw new Error(`Install failed: ${result.stderr}`);
		}
	} else {
		log.info(`Uploading local binary: ${binaryPath}`);
		await sandbox.upload(binaryPath, "/usr/local/bin/sandbox-agent");
	}

	// Verify installation
	const version = await sandbox.exec("sandbox-agent --version");
	log.success(`Installed: ${version.stdout.trim()}`);
}

// Install agents
async function installAgents(sandbox: Sandbox, agents: string[]): Promise<void> {
	log.section("Installing agents");

	for (const agent of agents) {
		log.info(`Installing ${agent}...`);

		if (agent === "claude" || agent === "codex") {
			const result = await sandbox.exec(`sandbox-agent install-agent ${agent}`);
			if (result.exitCode !== 0) throw new Error(`Failed to install ${agent}: ${result.stderr}`);
			log.success(`Installed ${agent}`);
		} else if (agent === "mock") {
			// Mock agent is built into sandbox-agent, no install needed
			log.info("Mock agent is built-in, skipping install");
		}
	}
}

// Start server and check health
async function startServerAndCheckHealth(sandbox: Sandbox): Promise<string> {
	log.section("Starting server");

	// Start server in background
	await sandbox.exec("nohup sandbox-agent server --no-token --host 0.0.0.0 --port 3000 >/tmp/sandbox-agent.log 2>&1 &");
	log.info("Server started in background");

	// Get base URL
	const baseUrl = await sandbox.getBaseUrl(3000);
	log.info(`Base URL: ${baseUrl}`);

	// Wait for health
	log.info("Waiting for health check...");
	for (let i = 0; i < 30; i++) {
		try {
			const response = await fetch(`${baseUrl}/v1/health`);
			if (response.ok) {
				const data = await response.json();
				if (data.status === "ok") {
					log.success("Health check passed!");
					return baseUrl;
				}
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 1000));
	}

	// Show logs on failure
	const logs = await sandbox.exec("cat /tmp/sandbox-agent.log");
	log.error("Server logs:\n" + logs.stdout);
	throw new Error("Health check failed after 30 seconds");
}

// Send a message and wait for response, auto-approving permissions
// Returns the response text
async function sendMessage(baseUrl: string, sessionId: string, message: string): Promise<string> {
	log.info(`Sending message: "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`);
	const msgRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/messages/stream`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message }),
	});
	if (!msgRes.ok || !msgRes.body) {
		throw new Error(`Failed to send message: ${await msgRes.text()}`);
	}

	// Process SSE stream
	const reader = msgRes.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let responseText = "";
	let receivedText = false;
	let hasError = false;
	let errorMessage = "";
	let pendingPermission: string | null = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const data = line.slice(6);
			if (data === "[DONE]") continue;

			try {
				const event = JSON.parse(data);
				log.debug(`Event: ${event.type}`);

				if (event.type === "item.delta") {
					const delta = event.data?.delta;
					const text = typeof delta === "string" ? delta : delta?.text || "";
					if (text) {
						if (!receivedText) {
							log.info("Receiving response...");
							receivedText = true;
						}
						process.stdout.write(text);
						responseText += text;
					}
				}

				// Handle permission requests - auto-approve
				if (event.type === "permission.requested") {
					const permissionId = event.data?.permission_id;
					if (permissionId) {
						pendingPermission = permissionId;
						log.info(`Permission requested (${permissionId}), auto-approving...`);
					}
				}

				if (event.type === "error") {
					hasError = true;
					errorMessage = event.data?.message || JSON.stringify(event.data);
					log.error(`Error event: ${errorMessage}`);
				}

				if (event.type === "agent.unparsed") {
					hasError = true;
					errorMessage = `Agent unparsed: ${JSON.stringify(event.data)}`;
					log.error(errorMessage);
				}
			} catch {}
		}

		// If we have a pending permission, approve it
		if (pendingPermission) {
			const permId = pendingPermission;
			pendingPermission = null;
			try {
				const approveRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/permissions/${permId}/reply`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ reply: "once" }),
				});
				if (approveRes.ok) {
					log.success(`Permission ${permId} approved`);
				} else {
					log.warn(`Failed to approve permission: ${await approveRes.text()}`);
				}
			} catch (err) {
				log.warn(`Error approving permission: ${err}`);
			}
		}
	}

	if (receivedText) {
		console.log(); // newline after response
	}

	if (hasError) {
		throw new Error(`Agent returned error: ${errorMessage}`);
	}

	return responseText;
}

// Test agent interaction
async function testAgent(baseUrl: string, agent: string, message: string): Promise<void> {
	log.section(`Testing ${agent} agent`);

	const sessionId = crypto.randomUUID();

	// Create session
	log.info(`Creating session ${sessionId}...`);
	const createRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ agent }),
	});
	if (!createRes.ok) {
		throw new Error(`Failed to create session: ${await createRes.text()}`);
	}
	log.success("Session created");

	const response = await sendMessage(baseUrl, sessionId, message);
	if (!response) {
		throw new Error("No response received from agent");
	}
	log.success("Received response from agent");
}

// Test that agent can actually modify files and run commands
async function testAgentActions(baseUrl: string, agent: string, sandbox: Sandbox): Promise<void> {
	log.section(`Testing ${agent} agent actions (file + command)`);

	const sessionId = crypto.randomUUID();
	const testFile = "/tmp/sandbox-test-file.txt";
	const expectedContent = "Hello from sandbox test!";

	// For Claude running as root in containers, we must use default permission mode
	// and handle permissions via the API (bypass mode is not supported as root).
	// For other agents, we can use bypass mode.
	const permissionMode = agent === "claude" ? "default" : "bypass";
	log.info(`Creating session ${sessionId} with permissionMode=${permissionMode}...`);
	const createRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ agent, permissionMode }),
	});
	if (!createRes.ok) {
		throw new Error(`Failed to create session: ${await createRes.text()}`);
	}
	log.success("Session created");

	// Ask agent to create a file
	const fileMessage = `Create a file at ${testFile} with exactly this content (no quotes, no extra text): ${expectedContent}`;
	await sendMessage(baseUrl, sessionId, fileMessage);

	// Verify file was created
	log.info("Verifying file was created...");
	const fileCheck = await sandbox.exec(`cat ${testFile} 2>&1`);
	if (fileCheck.exitCode !== 0) {
		throw new Error(`File was not created: ${fileCheck.stderr || fileCheck.stdout}`);
	}
	if (!fileCheck.stdout.includes("Hello from sandbox test")) {
		throw new Error(`File content mismatch. Expected "${expectedContent}", got "${fileCheck.stdout.trim()}"`);
	}
	log.success(`File created with correct content: "${fileCheck.stdout.trim()}"`);

	// Ask agent to run a command and create output
	const cmdMessage = `Run this command and tell me the output: echo "command-test-$(date +%s)" > /tmp/cmd-output.txt && cat /tmp/cmd-output.txt`;
	await sendMessage(baseUrl, sessionId, cmdMessage);

	// Verify command was executed
	log.info("Verifying command was executed...");
	const cmdCheck = await sandbox.exec("cat /tmp/cmd-output.txt 2>&1");
	if (cmdCheck.exitCode !== 0) {
		throw new Error(`Command output file not found: ${cmdCheck.stderr || cmdCheck.stdout}`);
	}
	if (!cmdCheck.stdout.includes("command-test-")) {
		throw new Error(`Command output mismatch. Expected "command-test-*", got "${cmdCheck.stdout.trim()}"`);
	}
	log.success(`Command executed successfully: "${cmdCheck.stdout.trim()}"`);
}

// Check environment diagnostics
async function checkEnvironment(sandbox: Sandbox): Promise<void> {
	log.section("Environment diagnostics");

	const checks = [
		{ name: "Environment variables", cmd: "env | grep -E 'ANTHROPIC|OPENAI|CLAUDE|CODEX' | sed 's/=.*/=<set>/'" },
		// Check both /root (Alpine) and /home/user (E2B/Debian) paths
		{ name: "Agent binaries", cmd: "ls -la ~/.local/share/sandbox-agent/bin/ 2>/dev/null || ls -la /root/.local/share/sandbox-agent/bin/ 2>/dev/null || ls -la /home/user/.local/share/sandbox-agent/bin/ 2>/dev/null || echo 'No agents installed'" },
		{ name: "Claude version", cmd: "~/.local/share/sandbox-agent/bin/claude --version 2>&1 || /root/.local/share/sandbox-agent/bin/claude --version 2>&1 || echo 'Claude not installed'" },
		{ name: "sandbox-agent version", cmd: "sandbox-agent --version 2>/dev/null || echo 'Not installed'" },
		{ name: "Server process", cmd: "pgrep -a sandbox-agent 2>/dev/null || ps aux | grep sandbox-agent | grep -v grep || echo 'Not running'" },
		{ name: "Server logs (last 50 lines)", cmd: "tail -50 /tmp/sandbox-agent.log 2>/dev/null || echo 'No logs'" },
		{ name: "Network: api.anthropic.com", cmd: "curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://api.anthropic.com/v1/messages 2>&1 || echo 'UNREACHABLE'" },
		{ name: "Network: api.openai.com", cmd: "curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 https://api.openai.com/v1/models 2>&1 || echo 'UNREACHABLE'" },
	];

	for (const { name, cmd } of checks) {
		const result = await sandbox.exec(cmd);
		console.log(`\n\x1b[1m${name}:\x1b[0m`);
		console.log(result.stdout || "(empty)");
		if (result.stderr) console.log(`stderr: ${result.stderr}`);
	}
}

// Main
async function main() {
	log.section(`Sandbox Testing (provider: ${provider})`);

	// Check credentials
	const anthropicKey = getAnthropicApiKey();
	const openaiKey = getOpenAiApiKey();

	log.info(`Anthropic API key: ${anthropicKey ? "found" : "not found"}`);
	log.info(`OpenAI API key: ${openaiKey ? "found" : "not found"}`);

	// Determine which agents to test
	let agents: string[];
	if (agentArg) {
		agents = [agentArg];
	} else if (anthropicKey) {
		agents = ["claude"];
	} else if (openaiKey) {
		agents = ["codex"];
	} else {
		agents = ["mock"];
		log.warn("No API keys found, using mock agent only");
	}
	log.info(`Agents to test: ${agents.join(", ")}`);

	// Get provider
	const prov = getProvider(provider);

	// Check required env vars
	for (const envVar of prov.requiredEnv) {
		if (!process.env[envVar]) {
			throw new Error(`Missing required environment variable: ${envVar}`);
		}
	}

	// Build
	const binaryPath = await buildSandboxAgent();

	// Create sandbox
	log.section(`Creating ${prov.name} sandbox`);
	const envVars: Record<string, string> = {};
	if (anthropicKey) envVars.ANTHROPIC_API_KEY = anthropicKey;
	if (openaiKey) envVars.OPENAI_API_KEY = openaiKey;

	const sandbox = await prov.create({ envVars });
	log.success(`Created sandbox: ${sandbox.id}`);

	try {
		// Install sandbox-agent
		await installSandboxAgent(sandbox, binaryPath);

		// Install agents (unless --skip-agent-install to test on-demand install like Daytona example)
		if (skipAgentInstall) {
			log.info("Skipping agent pre-install (testing on-demand installation)");
		} else {
			await installAgents(sandbox, agents);
		}

		// Check environment
		await checkEnvironment(sandbox);

		// Start server and check health
		const baseUrl = await startServerAndCheckHealth(sandbox);

		// Test each agent
		for (const agent of agents) {
			// Basic response test
			const message = agent === "mock" ? "hello" : "Say hello in 10 words or less";
			await testAgent(baseUrl, agent, message);

			// For real agents, also test file/command actions with permission handling.
			// Claude uses default permission mode and we auto-approve via API.
			// Other agents can use bypass mode.
			if (agent !== "mock") {
				await testAgentActions(baseUrl, agent, sandbox);
			}
		}

		log.section("All tests passed!");

		if (keepAlive) {
			log.info(`Sandbox ${sandbox.id} is still running. Press Ctrl+C to cleanup.`);
			log.info(`Base URL: ${await sandbox.getBaseUrl(3000)}`);
			await new Promise(() => {}); // Wait forever
		}
	} catch (err) {
		log.error(`Test failed: ${err}`);

		// Show diagnostics on failure
		try {
			await checkEnvironment(sandbox);
		} catch {}

		if (!keepAlive) {
			await sandbox.cleanup();
		}
		process.exit(1);
	}

	if (!keepAlive) {
		await sandbox.cleanup();
	}
}

main().catch((err) => {
	log.error(err.message || err);
	process.exit(1);
});
