import { $ } from "execa";
import type { ReleaseOpts } from "./main";
import { fetchGitRef, versionOrCommitToRef } from "./utils";

const IMAGE = "rivetdev/sandbox-agent";

export async function tagDocker(opts: ReleaseOpts) {
	// Determine which commit to use for source images
	let sourceCommit = opts.commit;
	if (opts.reuseEngineVersion) {
		console.log(`==> Reusing Docker images from ${opts.reuseEngineVersion}`);
		const ref = versionOrCommitToRef(opts.reuseEngineVersion);
		await fetchGitRef(ref);
		const result = await $`git rev-parse ${ref}`;
		sourceCommit = result.stdout.trim().slice(0, 7);
		console.log(`==> Source commit: ${sourceCommit}`);
	}

	// Check both architecture images exist using manifest inspect
	console.log(`==> Checking images exist: ${IMAGE}:${sourceCommit}-{amd64,arm64}`);
	try {
		console.log(`==> Inspecting ${IMAGE}:${sourceCommit}-amd64`);
		await $({ stdio: "inherit" })`docker manifest inspect ${IMAGE}:${sourceCommit}-amd64`;
		console.log(`==> Inspecting ${IMAGE}:${sourceCommit}-arm64`);
		await $({ stdio: "inherit" })`docker manifest inspect ${IMAGE}:${sourceCommit}-arm64`;
		console.log(`==> Both images exist`);
	} catch (error) {
		console.warn(`⚠️ Docker images ${IMAGE}:${sourceCommit}-{amd64,arm64} not found - skipping Docker tagging`);
		console.warn(`   To enable Docker tagging, build and push images first, then retry the release.`);
		return;
	}

	// Create and push manifest with version
	await createManifest(sourceCommit, opts.version);

	// Create and push manifest with latest
	if (opts.latest) {
		await createManifest(sourceCommit, "latest");
		await createManifest(sourceCommit, opts.minorVersionChannel);
	}
}

async function createManifest(from: string, to: string) {
	console.log(`==> Creating manifest: ${IMAGE}:${to} from ${IMAGE}:${from}-{amd64,arm64}`);

	// Use buildx imagetools to create and push multi-arch manifest
	// This works with manifest lists as inputs (unlike docker manifest create)
	await $({ stdio: "inherit" })`docker buildx imagetools create --tag ${IMAGE}:${to} ${IMAGE}:${from}-amd64 ${IMAGE}:${from}-arm64`;
}
