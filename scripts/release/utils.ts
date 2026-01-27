import * as fs from "node:fs/promises";
import { $ } from "execa";

export function assert(condition: unknown, message?: string): asserts condition {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
	if (actual !== expected) {
		throw new Error(message || `Expected ${expected}, got ${actual}`);
	}
}

export function assertExists<T>(
	value: T | null | undefined,
	message?: string,
): asserts value is T {
	if (value === null || value === undefined) {
		throw new Error(message || "Value does not exist");
	}
}

export async function assertDirExists(dirPath: string): Promise<void> {
	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) {
			throw new Error(`Path exists but is not a directory: ${dirPath}`);
		}
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			throw new Error(`Directory not found: ${dirPath}`);
		}
		throw err;
	}
}

// R2 configuration
const ENDPOINT_URL = "https://2a94c6a0ced8d35ea63cddc86c2681e7.r2.cloudflarestorage.com";
const BUCKET = "rivet-releases";

interface ReleasesS3Config {
	awsEnv: Record<string, string>;
	endpointUrl: string;
}

let cachedConfig: ReleasesS3Config | null = null;

export async function getReleasesS3Config(): Promise<ReleasesS3Config> {
	if (cachedConfig) {
		return cachedConfig;
	}

	let awsAccessKeyId = process.env.R2_RELEASES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
	let awsSecretAccessKey = process.env.R2_RELEASES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

	// Try 1Password fallback for local development
	if (!awsAccessKeyId) {
		try {
			const result = await $`op read ${"op://Engineering/rivet-releases R2 Upload/username"}`;
			awsAccessKeyId = result.stdout.trim();
		} catch {
			// 1Password not available
		}
	}
	if (!awsSecretAccessKey) {
		try {
			const result = await $`op read ${"op://Engineering/rivet-releases R2 Upload/password"}`;
			awsSecretAccessKey = result.stdout.trim();
		} catch {
			// 1Password not available
		}
	}

	assert(awsAccessKeyId, "R2_RELEASES_ACCESS_KEY_ID is required");
	assert(awsSecretAccessKey, "R2_RELEASES_SECRET_ACCESS_KEY is required");

	cachedConfig = {
		awsEnv: {
			AWS_ACCESS_KEY_ID: awsAccessKeyId,
			AWS_SECRET_ACCESS_KEY: awsSecretAccessKey,
			AWS_DEFAULT_REGION: "auto",
		},
		endpointUrl: ENDPOINT_URL,
	};

	return cachedConfig;
}

export async function uploadFileToReleases(
	localPath: string,
	remotePath: string,
): Promise<void> {
	const { awsEnv, endpointUrl } = await getReleasesS3Config();
	await $({
		env: awsEnv,
		stdio: "inherit",
	})`aws s3 cp ${localPath} s3://${BUCKET}/${remotePath} --checksum-algorithm CRC32 --endpoint-url ${endpointUrl}`;
}

export async function uploadDirToReleases(
	localPath: string,
	remotePath: string,
): Promise<void> {
	const { awsEnv, endpointUrl } = await getReleasesS3Config();
	await $({
		env: awsEnv,
		stdio: "inherit",
	})`aws s3 cp ${localPath} s3://${BUCKET}/${remotePath} --recursive --checksum-algorithm CRC32 --endpoint-url ${endpointUrl}`;
}

export async function uploadContentToReleases(
	content: string,
	remotePath: string,
): Promise<void> {
	const { awsEnv, endpointUrl } = await getReleasesS3Config();
	await $({
		env: awsEnv,
		input: content,
		stdio: ["pipe", "inherit", "inherit"],
	})`aws s3 cp - s3://${BUCKET}/${remotePath} --endpoint-url ${endpointUrl}`;
}

export interface ListReleasesResult {
	Contents?: { Key: string; Size: number }[];
}

export async function listReleasesObjects(
	prefix: string,
): Promise<ListReleasesResult> {
	const { awsEnv, endpointUrl } = await getReleasesS3Config();
	const result = await $({
		env: awsEnv,
		stdio: ["pipe", "pipe", "inherit"],
	})`aws s3api list-objects --bucket ${BUCKET} --prefix ${prefix} --endpoint-url ${endpointUrl}`;
	return JSON.parse(result.stdout);
}

export async function deleteReleasesPath(remotePath: string): Promise<void> {
	const { awsEnv, endpointUrl } = await getReleasesS3Config();
	await $({
		env: awsEnv,
		stdio: "inherit",
	})`aws s3 rm s3://${BUCKET}/${remotePath} --recursive --endpoint-url ${endpointUrl}`;
}

/**
 * Copies objects from one S3 path to another within the releases bucket.
 * Uses s3api copy-object to avoid R2 tagging header issues.
 */
export async function copyReleasesPath(
	sourcePath: string,
	targetPath: string,
): Promise<void> {
	const { awsEnv, endpointUrl } = await getReleasesS3Config();

	const listResult = await $({
		env: awsEnv,
	})`aws s3api list-objects --bucket ${BUCKET} --prefix ${sourcePath} --endpoint-url ${endpointUrl}`;

	const objects = JSON.parse(listResult.stdout);
	if (!objects.Contents?.length) {
		throw new Error(`No objects found under ${sourcePath}`);
	}

	for (const obj of objects.Contents) {
		const sourceKey = obj.Key;
		const targetKey = sourceKey.replace(sourcePath, targetPath);
		console.log(`  ${sourceKey} -> ${targetKey}`);
		await $({
			env: awsEnv,
		})`aws s3api copy-object --bucket ${BUCKET} --key ${targetKey} --copy-source ${BUCKET}/${sourceKey} --endpoint-url ${endpointUrl}`;
	}
}
