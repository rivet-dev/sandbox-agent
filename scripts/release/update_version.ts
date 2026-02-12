import * as fs from "node:fs/promises";
import { join } from "node:path";
import { $ } from "execa";
import { glob } from "glob";
import type { ReleaseOpts } from "./main";

function assert(condition: any, message?: string): asserts condition {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

export async function updateVersion(opts: ReleaseOpts) {
	// 1. Update workspace version and internal crate versions in root Cargo.toml
	const cargoTomlPath = join(opts.root, "Cargo.toml");
	let cargoContent = await fs.readFile(cargoTomlPath, "utf-8");

	// Update [workspace.package] version
	assert(
		/\[workspace\.package\]\nversion = ".*"/.test(cargoContent),
		"Could not find workspace.package version in Cargo.toml",
	);
	cargoContent = cargoContent.replace(
		/\[workspace\.package\]\nversion = ".*"/,
		`[workspace.package]\nversion = "${opts.version}"`,
	);

	// Discover internal crates from [workspace.dependencies] by matching
	// lines with both `version = "..."` and `path = "..."` (internal path deps)
	const internalCratePattern = /^(\S+)\s*=\s*\{[^}]*version\s*=\s*"[^"]+"\s*,[^}]*path\s*=/gm;
	let match;
	const internalCrates: string[] = [];
	while ((match = internalCratePattern.exec(cargoContent)) !== null) {
		internalCrates.push(match[1]);
	}

	console.log(`Discovered ${internalCrates.length} internal crates to version-bump:`);
	for (const crate of internalCrates) console.log(`  - ${crate}`);

	for (const crate of internalCrates) {
		const pattern = new RegExp(
			`(${crate.replace(/-/g, "-")} = \\{ version = ")[^"]+(",)`,
			"g",
		);
		cargoContent = cargoContent.replace(pattern, `$1${opts.version}$2`);
	}

	await fs.writeFile(cargoTomlPath, cargoContent);
	await $({ cwd: opts.root })`git add Cargo.toml`;

	// 2. Discover and update all non-private SDK package.json versions
	const packageJsonPaths = await glob("sdks/**/package.json", {
		cwd: opts.root,
		ignore: ["**/node_modules/**"],
	});

	// Filter to non-private packages only
	const toUpdate: string[] = [];
	for (const relPath of packageJsonPaths) {
		const fullPath = join(opts.root, relPath);
		const content = await fs.readFile(fullPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.private) continue;
		toUpdate.push(relPath);
	}

	console.log(`Discovered ${toUpdate.length} SDK package.json files to version-bump:`);
	for (const relPath of toUpdate) console.log(`  - ${relPath}`);

	for (const relPath of toUpdate) {
		const fullPath = join(opts.root, relPath);
		const content = await fs.readFile(fullPath, "utf-8");

		const versionPattern = /"version": ".*"/;
		assert(versionPattern.test(content), `No version field in ${relPath}`);

		const updated = content.replace(versionPattern, `"version": "${opts.version}"`);
		await fs.writeFile(fullPath, updated);
		await $({ cwd: opts.root })`git add ${relPath}`;
	}
}
