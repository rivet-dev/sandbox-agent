import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "execa";
import * as semver from "semver";
import type { ReleaseOpts } from "./main.js";

const CRATE_ORDER = [
	"error",
	"agent-credentials",
	"agent-schema",
	"universal-agent-schema",
	"agent-management",
	"sandbox-agent",
];

const PLATFORM_MAP: Record<string, { pkg: string; os: string; cpu: string; ext: string }> = {
	"x86_64-unknown-linux-musl": { pkg: "linux-x64", os: "linux", cpu: "x64", ext: "" },
	"x86_64-pc-windows-gnu": { pkg: "win32-x64", os: "win32", cpu: "x64", ext: ".exe" },
	"x86_64-apple-darwin": { pkg: "darwin-x64", os: "darwin", cpu: "x64", ext: "" },
	"aarch64-apple-darwin": { pkg: "darwin-arm64", os: "darwin", cpu: "arm64", ext: "" },
};

async function npmVersionExists(packageName: string, version: string): Promise<boolean> {
	console.log(`Checking if ${packageName}@${version} exists on npm...`);
	try {
		await $({
			stdout: "ignore",
			stderr: "pipe",
		})`npm view ${packageName}@${version} version`;
		return true;
	} catch (error: unknown) {
		const stderr = error && typeof error === "object" && "stderr" in error
			? String(error.stderr)
			: "";
		if (
			stderr.includes(`No match found for version ${version}`) ||
			stderr.includes(`'${packageName}@${version}' is not in this registry`)
		) {
			return false;
		}
		// Unexpected error, assume not exists to allow publish attempt
		return false;
	}
}

async function crateVersionExists(crateName: string, version: string): Promise<boolean> {
	console.log(`Checking if ${crateName}@${version} exists on crates.io...`);
	try {
		const result = await $`cargo search ${crateName} --limit 1`;
		const output = result.stdout || "";
		const match = output.match(new RegExp(`^${crateName}\\s*=\\s*"([^"]+)"`));
		return !!(match && match[1] === version);
	} catch {
		return false;
	}
}

function getNpmTag(version: string, latest: boolean): string | null {
	if (latest) return null;
	const parsed = semver.parse(version);
	if (!parsed) throw new Error(`Invalid version: ${version}`);

	if (parsed.prerelease.length === 0) {
		return "next";
	}
	const hasRc = parsed.prerelease.some((part) =>
		String(part).toLowerCase().startsWith("rc")
	);
	if (hasRc) {
		return "rc";
	}
	throw new Error(`Prerelease versions must use rc tag when not latest: ${version}`);
}

export async function publishCrates(opts: ReleaseOpts) {
	for (const crate of CRATE_ORDER) {
		const crateName = `sandbox-agent-${crate}`;

		if (await crateVersionExists(crateName, opts.version)) {
			console.log(`==> Skipping ${crateName}@${opts.version} (already published)`);
			continue;
		}

		console.log(`==> Publishing ${crateName}@${opts.version}`);
		const crateDir = path.join(opts.root, "server", "packages", crate);
		await $({ stdio: "inherit", cwd: crateDir })`cargo publish --allow-dirty`;

		console.log("Waiting 30s for crates.io index...");
		await new Promise(resolve => setTimeout(resolve, 30000));
	}
}

export async function publishNpmSdk(opts: ReleaseOpts) {
	const sdkDir = path.join(opts.root, "sdks", "typescript");
	const packageName = "sandbox-agent";

	if (await npmVersionExists(packageName, opts.version)) {
		console.log(`==> Skipping ${packageName}@${opts.version} (already published)`);
		return;
	}

	console.log(`==> Publishing ${packageName}@${opts.version}`);
	const npmTag = getNpmTag(opts.version, opts.latest);

	await $({ stdio: "inherit", cwd: sdkDir })`npm version ${opts.version} --no-git-tag-version --allow-same-version`;
	await $({ stdio: "inherit", cwd: sdkDir })`pnpm install`;
	await $({ stdio: "inherit", cwd: sdkDir })`pnpm run build`;

	const publishArgs = ["publish", "--access", "public"];
	if (npmTag) publishArgs.push("--tag", npmTag);
	await $({ stdio: "inherit", cwd: sdkDir })`npm ${publishArgs}`;
}

export async function publishNpmCli(opts: ReleaseOpts) {
	const cliDir = path.join(opts.root, "sdks", "cli");
	const distDir = path.join(opts.root, "dist");
	const npmTag = getNpmTag(opts.version, opts.latest);

	// Publish platform-specific packages
	for (const [target, info] of Object.entries(PLATFORM_MAP)) {
		const packageName = `@sandbox-agent/cli-${info.pkg}`;

		if (await npmVersionExists(packageName, opts.version)) {
			console.log(`==> Skipping ${packageName}@${opts.version} (already published)`);
			continue;
		}

		const platformDir = path.join(cliDir, "platforms", info.pkg);
		const binDir = path.join(platformDir, "bin");
		await fs.mkdir(binDir, { recursive: true });

		const srcBinary = path.join(distDir, `sandbox-agent-${target}${info.ext}`);
		const dstBinary = path.join(binDir, `sandbox-agent${info.ext}`);
		await fs.copyFile(srcBinary, dstBinary);
		if (info.ext !== ".exe") {
			await fs.chmod(dstBinary, 0o755);
		}

		console.log(`==> Publishing ${packageName}@${opts.version}`);
		await $({ stdio: "inherit", cwd: platformDir })`npm version ${opts.version} --no-git-tag-version --allow-same-version`;

		const publishArgs = ["publish", "--access", "public"];
		if (npmTag) publishArgs.push("--tag", npmTag);
		await $({ stdio: "inherit", cwd: platformDir })`npm ${publishArgs}`;
	}

	// Publish main CLI package
	const mainPackageName = "@sandbox-agent/cli";
	if (await npmVersionExists(mainPackageName, opts.version)) {
		console.log(`==> Skipping ${mainPackageName}@${opts.version} (already published)`);
		return;
	}

	console.log(`==> Publishing ${mainPackageName}@${opts.version}`);
	const pkgPath = path.join(cliDir, "package.json");
	const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
	pkg.version = opts.version;
	for (const dep of Object.keys(pkg.optionalDependencies || {})) {
		pkg.optionalDependencies[dep] = opts.version;
	}
	await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

	const publishArgs = ["publish", "--access", "public"];
	if (npmTag) publishArgs.push("--tag", npmTag);
	await $({ stdio: "inherit", cwd: cliDir })`npm ${publishArgs}`;
}
