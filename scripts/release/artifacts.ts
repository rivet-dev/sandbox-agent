import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "execa";
import type { ReleaseOpts } from "./main.js";
import {
	assertDirExists,
	copyReleasesPath,
	deleteReleasesPath,
	listReleasesObjects,
	uploadContentToReleases,
	uploadDirToReleases,
	uploadFileToReleases,
} from "./utils.js";

const PREFIX = "sandbox-agent";

const BINARY_FILES = [
	"sandbox-agent-x86_64-unknown-linux-musl",
	"sandbox-agent-x86_64-pc-windows-gnu.exe",
	"sandbox-agent-x86_64-apple-darwin",
	"sandbox-agent-aarch64-apple-darwin",
];

/**
 * Build TypeScript SDK and upload to commit directory.
 * This is called during setup-ci phase.
 */
export async function buildAndUploadArtifacts(opts: ReleaseOpts) {
	console.log("==> Building TypeScript SDK");
	const sdkDir = path.join(opts.root, "sdks", "typescript");
	await $({ stdio: "inherit", cwd: sdkDir })`pnpm install`;
	await $({ stdio: "inherit", cwd: sdkDir })`pnpm run build`;

	const distPath = path.join(sdkDir, "dist");
	await assertDirExists(distPath);

	console.log(`==> Uploading TypeScript SDK to ${PREFIX}/${opts.commit}/typescript/`);
	await uploadDirToReleases(distPath, `${PREFIX}/${opts.commit}/typescript/`);

	console.log("✅ TypeScript SDK artifacts uploaded");
}

/**
 * Promote artifacts from commit directory to version directory.
 * This is called during complete-ci phase.
 */
export async function promoteArtifacts(opts: ReleaseOpts) {
	// Promote TypeScript SDK
	await promotePath(opts, "typescript");
}

async function promotePath(opts: ReleaseOpts, name: string) {
	console.log(`==> Promoting ${name} artifacts`);

	const sourcePrefix = `${PREFIX}/${opts.commit}/${name}/`;
	const commitFiles = await listReleasesObjects(sourcePrefix);
	if (!Array.isArray(commitFiles?.Contents) || commitFiles.Contents.length === 0) {
		throw new Error(`No files found under ${sourcePrefix}`);
	}

	await copyPath(sourcePrefix, `${PREFIX}/${opts.version}/${name}/`);
	if (opts.latest) {
		await copyPath(sourcePrefix, `${PREFIX}/latest/${name}/`);
	}
}

async function copyPath(sourcePrefix: string, targetPrefix: string) {
	console.log(`Copying ${sourcePrefix} -> ${targetPrefix}`);
	await deleteReleasesPath(targetPrefix);
	await copyReleasesPath(sourcePrefix, targetPrefix);
}

/**
 * Upload install script with version substitution.
 */
export async function uploadInstallScripts(opts: ReleaseOpts) {
	const installPath = path.join(opts.root, "scripts", "release", "static", "install.sh");
	let installContent = await fs.readFile(installPath, "utf8");

	const uploadForVersion = async (versionValue: string, remoteVersion: string) => {
		const content = installContent.replace(/__VERSION__/g, versionValue);
		const uploadKey = `${PREFIX}/${remoteVersion}/install.sh`;
		console.log(`Uploading install script: ${uploadKey}`);
		await uploadContentToReleases(content, uploadKey);
	};

	await uploadForVersion(opts.version, opts.version);
	if (opts.latest) {
		await uploadForVersion("latest", "latest");
	}
}

/**
 * Upload compiled binaries from dist/ directory.
 */
export async function uploadBinaries(opts: ReleaseOpts) {
	const distDir = path.join(opts.root, "dist");
	await assertDirExists(distDir);

	for (const fileName of BINARY_FILES) {
		const localPath = path.join(distDir, fileName);

		try {
			await fs.access(localPath);
		} catch {
			throw new Error(`Missing binary: ${localPath}`);
		}

		console.log(`Uploading binary: ${fileName}`);
		await uploadFileToReleases(localPath, `${PREFIX}/${opts.version}/${fileName}`);
		if (opts.latest) {
			await uploadFileToReleases(localPath, `${PREFIX}/latest/${fileName}`);
		}
	}

	console.log("✅ Binaries uploaded");
}
