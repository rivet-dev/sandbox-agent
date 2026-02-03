import { execSync, spawnSync } from "node:child_process";
import * as os from "node:os";

export const SANDBOXD_SOCK = `${os.homedir()}/.docker/sandboxes/sandboxd.sock`;
export const VM_NAME = "sandbox-agent-vm";

export const exec = (cmd: string, opts?: { silent?: boolean }) =>
	execSync(cmd, { encoding: "utf-8", stdio: opts?.silent ? "pipe" : "inherit" })?.trim() ?? "";

export const vmExec = (vmSock: string, cmd: string, env?: Record<string, string>) => {
	const envFlags = env ? Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];
	const r = spawnSync("docker", ["--host", `unix://${vmSock}`, "exec", ...envFlags, "sandbox", "sh", "-c", cmd], { encoding: "utf-8", stdio: "pipe" });
	if (r.error) throw r.error;
	return r.stdout?.trim() ?? "";
};

export const cleanup = () => {
	try { exec(`curl -s -X DELETE --unix-socket "${SANDBOXD_SOCK}" http://localhost/vm/${VM_NAME}`); } catch {}
};

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const runPrompt = async (vmSock: string): Promise<void> => {
	const { createInterface } = await import("node:readline/promises");
	const { spawn } = await import("node:child_process");

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const sessionId = `session-${Date.now()}`;
	vmExec(vmSock, `sandbox-agent api sessions create ${sessionId} --agent claude`);
	console.log(`Session: ${sessionId}\nPress Ctrl+C to quit.\n`);

	const sendMessage = (input: string) => new Promise<void>((resolve) => {
		const proc = spawn("docker", [
			"--host", `unix://${vmSock}`, "exec", "sandbox", "sh", "-c",
			`sandbox-agent api sessions send-message-stream ${sessionId} --message "${input.replace(/"/g, '\\"')}"`,
		]);

		proc.stdout.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString().split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const evt = JSON.parse(line.slice(6));
				if (evt.type === "item.delta" && evt.data?.delta) {
					const isUserEcho = evt.data.item_id?.includes("user") || evt.data.native_item_id?.includes("user");
					if (!isUserEcho) process.stdout.write(evt.data.delta);
				}
			}
		});

		proc.on("close", () => { console.log(); resolve(); });
	});

	for await (const input of rl) {
		if (input.trim()) await sendMessage(input);
		process.stdout.write("> ");
	}
};
