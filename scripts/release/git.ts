import { $ } from "execa";
import * as semver from "semver";
import type { ReleaseOpts } from "./main.js";

export async function validateGit(_opts: ReleaseOpts) {
	const result = await $`git status --porcelain`;
	const status = result.stdout;
	if (status.trim().length > 0) {
		throw new Error(
			"There are uncommitted changes. Please commit or stash them.",
		);
	}
}

export async function createAndPushTag(opts: ReleaseOpts) {
	console.log(`Creating tag v${opts.version}...`);
	try {
		await $({ stdio: "inherit", cwd: opts.root })`git tag -f v${opts.version}`;
		await $({ stdio: "inherit", cwd: opts.root })`git push origin v${opts.version} -f`;
		console.log(`✅ Tag v${opts.version} created and pushed`);
	} catch (err) {
		console.error("❌ Failed to create or push tag");
		throw err;
	}
}

export async function createGitHubRelease(opts: ReleaseOpts) {
	console.log("Creating GitHub release...");

	try {
		console.log(`Looking for existing release for ${opts.version}`);

		const { stdout: releaseJson } = await $({
			cwd: opts.root,
		})`gh release list --json name,tagName`;
		const releases = JSON.parse(releaseJson);
		const existingRelease = releases.find(
			(r: { name: string }) => r.name === opts.version,
		);

		if (existingRelease) {
			console.log(
				`Updating release ${opts.version} to point to tag v${opts.version}`,
			);
			await $({
				stdio: "inherit",
				cwd: opts.root,
			})`gh release edit ${existingRelease.tagName} --tag v${opts.version}`;
		} else {
			console.log(
				`Creating new release ${opts.version} pointing to tag v${opts.version}`,
			);
			await $({
				stdio: "inherit",
				cwd: opts.root,
			})`gh release create v${opts.version} --title ${opts.version} --generate-notes`;

			// Mark as prerelease if needed
			const parsed = semver.parse(opts.version);
			if (parsed && parsed.prerelease.length > 0) {
				await $({
					stdio: "inherit",
					cwd: opts.root,
				})`gh release edit v${opts.version} --prerelease`;
			}
		}

		console.log("✅ GitHub release created/updated");
	} catch (err) {
		console.error("❌ Failed to create GitHub release");
		console.warn("! You may need to create the release manually");
		throw err;
	}
}
