import { $ } from "execa";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseOpts } from "./main";
import { downloadFromReleases, PREFIX } from "./utils";

// Crates to publish in dependency order
const CRATES = [
	"error",
	"agent-credentials",
	"extracted-agent-schemas",
	"universal-agent-schema",
	"agent-management",
	"sandbox-agent",
	"gigacode",
] as const;

// NPM CLI packages
const CLI_PACKAGES = [
	"@sandbox-agent/cli",
	"@sandbox-agent/cli-linux-x64",
	"@sandbox-agent/cli-linux-arm64",
	"@sandbox-agent/cli-win32-x64",
	"@sandbox-agent/cli-darwin-x64",
	"@sandbox-agent/cli-darwin-arm64",
	"@sandbox-agent/gigacode",
	"@sandbox-agent/gigacode-linux-x64",
	"@sandbox-agent/gigacode-linux-arm64",
	"@sandbox-agent/gigacode-win32-x64",
	"@sandbox-agent/gigacode-darwin-x64",
	"@sandbox-agent/gigacode-darwin-arm64",
] as const;

// Mapping from npm package name to Rust target and binary extension
const CLI_PLATFORM_MAP: Record<
	string,
	{ target: string; binaryExt: string; binaryName: string }
> = {
	"@sandbox-agent/cli-linux-x64": {
		target: "x86_64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-linux-arm64": {
		target: "aarch64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-win32-x64": {
		target: "x86_64-pc-windows-gnu",
		binaryExt: ".exe",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-darwin-x64": {
		target: "x86_64-apple-darwin",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-darwin-arm64": {
		target: "aarch64-apple-darwin",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/gigacode-linux-x64": {
		target: "x86_64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-linux-arm64": {
		target: "aarch64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-win32-x64": {
		target: "x86_64-pc-windows-gnu",
		binaryExt: ".exe",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-darwin-x64": {
		target: "x86_64-apple-darwin",
		binaryExt: "",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-darwin-arm64": {
		target: "aarch64-apple-darwin",
		binaryExt: "",
		binaryName: "gigacode",
	},
};

async function npmVersionExists(
	packageName: string,
	version: string,
): Promise<boolean> {
	console.log(
		`==> Checking if NPM version exists: ${packageName}@${version}`,
	);
	try {
		await $({
			stdout: "ignore",
			stderr: "pipe",
		})`npm view ${packageName}@${version} version`;
		return true;
	} catch (error: any) {
		if (error.stderr) {
			if (
				!error.stderr.includes(
					`No match found for version ${version}`,
				) &&
				!error.stderr.includes(
					`'${packageName}@${version}' is not in this registry.`,
				)
			) {
				throw new Error(
					`unexpected npm view version output: ${error.stderr}`,
				);
			}
		}
		return false;
	}
}

async function crateVersionExists(
	crateName: string,
	version: string,
): Promise<boolean> {
	console.log(`==> Checking if crate version exists: ${crateName}@${version}`);
	try {
		const result = await $({
			stdout: "pipe",
			stderr: "pipe",
		})`cargo search ${crateName} --limit 1`;
		// cargo search output format: "cratename = \"version\" # description"
		const output = result.stdout;
		const match = output.match(new RegExp(`^${crateName}\\s*=\\s*"([^"]+)"`));
		if (match && match[1] === version) {
			return true;
		}
		return false;
	} catch (error: any) {
		// If cargo search fails, assume crate doesn't exist
		return false;
	}
}

export async function publishCrates(opts: ReleaseOpts) {
	console.log("==> Publishing crates to crates.io");

	for (const crate of CRATES) {
		const cratePath = join(opts.root, "server/packages", crate);

		// Read Cargo.toml to get the actual crate name
		const cargoTomlPath = join(cratePath, "Cargo.toml");
		const cargoToml = await fs.readFile(cargoTomlPath, "utf-8");
		const nameMatch = cargoToml.match(/^name\s*=\s*"([^"]+)"/m);
		const crateName = nameMatch ? nameMatch[1] : `sandbox-agent-${crate}`;

		// Check if version already exists
		const versionExists = await crateVersionExists(crateName, opts.version);
		if (versionExists) {
			console.log(
				`Version ${opts.version} of ${crateName} already exists on crates.io. Skipping...`,
			);
			continue;
		}

		// Publish
		// Use --no-verify to skip the verification step because:
		// 1. Code was already built/checked in the setup phase
		// 2. Verification downloads published dependencies which may not have the latest
		//    changes yet (crates.io indexing takes time)
		console.log(`==> Publishing to crates.io: ${crateName}@${opts.version}`);

		try {
			await $({
				stdout: "pipe",
				stderr: "pipe",
				cwd: cratePath,
			})`cargo publish --allow-dirty --no-verify`;
			console.log(`✅ Published ${crateName}@${opts.version}`);
		} catch (err: any) {
			// Check if error is because crate already exists (from a previous partial run)
			if (err.stderr?.includes("already exists")) {
				console.log(
					`Version ${opts.version} of ${crateName} already exists on crates.io. Skipping...`,
				);
				continue;
			}
			console.error(`❌ Failed to publish ${crateName}`);
			console.error(err.stderr || err.message);
			throw err;
		}

		// Wait a bit for crates.io to index the new version (needed for dependency resolution)
		console.log("Waiting for crates.io to index...");
		await new Promise((resolve) => setTimeout(resolve, 30000));
	}

	console.log("✅ All crates published");
}

export async function publishNpmCliShared(opts: ReleaseOpts) {
	const cliSharedPath = join(opts.root, "sdks/cli-shared");
	const packageJsonPath = join(cliSharedPath, "package.json");
	const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
	const name = packageJson.name;

	// Check if version already exists
	const versionExists = await npmVersionExists(name, opts.version);
	if (versionExists) {
		console.log(
			`Version ${opts.version} of ${name} already exists. Skipping...`,
		);
		return;
	}

	// Build cli-shared
	console.log(`==> Building @sandbox-agent/cli-shared`);
	await $({
		stdio: "inherit",
		cwd: opts.root,
	})`pnpm --filter @sandbox-agent/cli-shared build`;

	// Publish
	console.log(`==> Publishing to NPM: ${name}@${opts.version}`);

	// Add --tag flag for release candidates
	const isReleaseCandidate = opts.version.includes("-rc.");
	const tag = isReleaseCandidate ? "rc" : "latest";

	await $({
		stdio: "inherit",
		cwd: cliSharedPath,
	})`pnpm publish --access public --tag ${tag} --no-git-checks`;

	console.log(`✅ Published ${name}@${opts.version}`);
}

export async function publishNpmSdk(opts: ReleaseOpts) {
	const sdkPath = join(opts.root, "sdks/typescript");
	const packageJsonPath = join(sdkPath, "package.json");
	const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
	const name = packageJson.name;

	// Check if version already exists
	const versionExists = await npmVersionExists(name, opts.version);
	if (versionExists) {
		console.log(
			`Version ${opts.version} of ${name} already exists. Skipping...`,
		);
		return;
	}

	// Build the SDK (cli-shared should already be built by publishNpmCliShared)
	console.log(`==> Building TypeScript SDK`);
	await $({
		stdio: "inherit",
		cwd: opts.root,
	})`pnpm --filter sandbox-agent build`;

	// Publish
	console.log(`==> Publishing to NPM: ${name}@${opts.version}`);

	// Add --tag flag for release candidates
	const isReleaseCandidate = opts.version.includes("-rc.");
	const tag = isReleaseCandidate ? "rc" : "latest";

	await $({
		stdio: "inherit",
		cwd: sdkPath,
	})`pnpm publish --access public --tag ${tag} --no-git-checks`;

	console.log(`✅ Published ${name}@${opts.version}`);
}

export async function publishNpmCli(opts: ReleaseOpts) {
	console.log("==> Publishing CLI packages to NPM");

	// Determine which commit to use for downloading binaries
	let sourceCommit = opts.commit;
	if (opts.reuseEngineVersion) {
		const ref = opts.reuseEngineVersion.includes(".")
			? `v${opts.reuseEngineVersion}`
			: opts.reuseEngineVersion;
		const result = await $`git rev-parse ${ref}`;
		sourceCommit = result.stdout.trim().slice(0, 7);
		console.log(`Using binaries from commit: ${sourceCommit}`);
	}

	for (const packageName of CLI_PACKAGES) {
		// Check if version already exists
		const versionExists = await npmVersionExists(packageName, opts.version);
		if (versionExists) {
			console.log(
				`Version ${opts.version} of ${packageName} already exists. Skipping...`,
			);
			continue;
		}

		// Determine package path
		let packagePath: string;
		if (packageName === "@sandbox-agent/cli") {
			packagePath = join(opts.root, "sdks/cli");
		} else if (packageName === "@sandbox-agent/gigacode") {
			packagePath = join(opts.root, "sdks/gigacode");
		} else if (packageName.startsWith("@sandbox-agent/cli-")) {
			// Platform-specific packages: @sandbox-agent/cli-linux-x64 -> sdks/cli/platforms/linux-x64
			const platform = packageName.replace("@sandbox-agent/cli-", "");
			packagePath = join(opts.root, "sdks/cli/platforms", platform);
		} else if (packageName.startsWith("@sandbox-agent/gigacode-")) {
			// Platform-specific packages: @sandbox-agent/gigacode-linux-x64 -> sdks/gigacode/platforms/linux-x64
			const platform = packageName.replace("@sandbox-agent/gigacode-", "");
			packagePath = join(opts.root, "sdks/gigacode/platforms", platform);
		} else {
			throw new Error(`Unknown CLI package: ${packageName}`);
		}

		// Download binary from R2 for platform-specific packages
		const platformInfo = CLI_PLATFORM_MAP[packageName];
		if (platformInfo) {
			const binDir = join(packagePath, "bin");
			const binaryName = `${platformInfo.binaryName}${platformInfo.binaryExt}`;
			const localBinaryPath = join(binDir, binaryName);
			const remoteBinaryPath = `${PREFIX}/${sourceCommit}/binaries/${platformInfo.binaryName}-${platformInfo.target}${platformInfo.binaryExt}`;

			console.log(`==> Downloading binary for ${packageName}`);
			console.log(`    From: ${remoteBinaryPath}`);
			console.log(`    To: ${localBinaryPath}`);

			// Create bin directory
			await fs.mkdir(binDir, { recursive: true });

			// Download binary
			await downloadFromReleases(remoteBinaryPath, localBinaryPath);

			// Make binary executable (not needed on Windows)
			if (!platformInfo.binaryExt) {
				await fs.chmod(localBinaryPath, 0o755);
			}
		}

		// Publish
		console.log(`==> Publishing to NPM: ${packageName}@${opts.version}`);

		// Add --tag flag for release candidates
		const isReleaseCandidate = opts.version.includes("-rc.");
		const tag = isReleaseCandidate ? "rc" : "latest";

		try {
			await $({
				stdio: "inherit",
				cwd: packagePath,
			})`pnpm publish --access public --tag ${tag} --no-git-checks`;
			console.log(`✅ Published ${packageName}@${opts.version}`);
		} catch (err) {
			console.error(`❌ Failed to publish ${packageName}`);
			throw err;
		}
	}

	console.log("✅ All CLI packages published");
}
