import * as os from "node:os";
import { exec, vmExec, sleep, runPrompt, SANDBOXD_SOCK, VM_NAME } from "./utils.js";

// Global error handlers
process.on("uncaughtException", (err) => {
	console.error("Error:", err.message);
	if (err.message.includes("docker.sock")) {
		console.error("Try: pnpm cleanup && pnpm start");
	}
	process.exit(1);
});

// Check prerequisites
try {
	exec("docker sandbox --help", { silent: true });
} catch {
	console.error(
		"Docker Sandbox not available. Requires Docker Desktop 4.58+ on macOS/Windows.",
	);
	process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
	console.error("ANTHROPIC_API_KEY environment variable is required");
	process.exit(1);
}

// Check if VM already exists
const vms = JSON.parse(
	exec(`curl -s --unix-socket "${SANDBOXD_SOCK}" http://localhost/vm`, { silent: true }),
);
const existingVm = vms.find((v: { vm_name: string }) => v.vm_name === VM_NAME);

let vmSock: string;
if (existingVm) {
	console.log(`Using existing VM: ${existingVm.vm_id}`);
	vmSock = `${os.homedir()}/.docker/sandboxes/vm/${VM_NAME}/docker.sock`;
} else {
	// Create VM
	console.log("Creating VM (one-time setup)...");
	const payload = JSON.stringify({
		agent_name: "sandbox-agent",
		workspace_dir: process.cwd(),
	});
	const vm = JSON.parse(
		exec(
			`curl -s -X POST --unix-socket "${SANDBOXD_SOCK}" http://localhost/vm -H "Content-Type: application/json" -d '${payload}'`,
			{ silent: true },
		),
	);
	if (!vm.vm_id) throw new Error(`Failed to create VM: ${JSON.stringify(vm)}`);
	vmSock =
		vm.vm_config?.socketPath ??
		`${os.homedir()}/.docker/sandboxes/vm/${VM_NAME}/docker.sock`;
	console.log(`VM created: ${vm.vm_id}`);

	// Build and load image (only needed once per VM)
	console.log("Building image (one-time setup)...");
	exec(`docker build -t sandbox-agent-template:latest .`);
	console.log("Loading image into VM (one-time setup)...");
	exec(`docker save sandbox-agent-template:latest | docker --host "unix://${vmSock}" load`);
}

// Check if container already exists
const containerExists = exec(
	`docker --host "unix://${vmSock}" ps -a --filter name=^sandbox$ --format "{{.Status}}"`,
	{ silent: true },
);

if (containerExists.includes("Up")) {
	console.log("Container already running");
} else if (containerExists) {
	console.log("Starting existing container...");
	exec(`docker --host "unix://${vmSock}" start sandbox`, { silent: true });
} else {
	console.log("Creating container...");
	// Note: Docker Sandbox requires proxy for outbound HTTPS
	exec(
		`docker --host "unix://${vmSock}" run -d --name sandbox ` +
		`-e HTTP_PROXY=http://host.docker.internal:3128 ` +
		`-e HTTPS_PROXY=http://host.docker.internal:3128 ` +
		`-e NO_PROXY=localhost,127.0.0.1 ` +
		`-e NODE_TLS_REJECT_UNAUTHORIZED=0 ` +
		`-e ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY}" ` +
		`-v "${process.cwd()}:${process.cwd()}" -w "${process.cwd()}" ` +
		`sandbox-agent-template:latest sandbox-agent server --no-token --host 0.0.0.0`,
		{ silent: true },
	);
}

// Wait for server
console.log("Waiting for healthy...");
const start = Date.now();
while (Date.now() - start < 30000) {
	try {
		if (vmExec(vmSock, "sandbox-agent api sessions list").includes("sessions")) break;
	} catch {}
	await sleep(500);
}

// Interactive prompt loop
await runPrompt(vmSock);
