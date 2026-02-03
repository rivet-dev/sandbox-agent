import * as fs from "node:fs/promises";
import { $ } from "execa";
import { glob } from "glob";
import type { ReleaseOpts } from "./main";

function assert(condition: any, message?: string): asserts condition {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

export async function updateVersion(opts: ReleaseOpts) {
	// Define substitutions
	const findReplace = [
		{
			path: "Cargo.toml",
			find: /\[workspace\.package\]\nversion = ".*"/,
			replace: `[workspace.package]\nversion = "${opts.version}"`,
		},
		{
			path: "sdks/cli-shared/package.json",
			find: /"version": ".*"/,
			replace: `"version": "${opts.version}"`,
		},
		{
			path: "sdks/typescript/package.json",
			find: /"version": ".*"/,
			replace: `"version": "${opts.version}"`,
		},
		{
			path: "sdks/cli/package.json",
			find: /"version": ".*"/,
			replace: `"version": "${opts.version}"`,
		},
		{
			path: "sdks/cli/platforms/*/package.json",
			find: /"version": ".*"/,
			replace: `"version": "${opts.version}"`,
		},
	];

	// Update internal crate versions in workspace dependencies
	// These need to match the new version so cargo publish can resolve them correctly
	const internalCrates = [
		"sandbox-agent",
		"sandbox-agent-error",
		"sandbox-agent-agent-management",
		"sandbox-agent-agent-credentials",
		"sandbox-agent-universal-agent-schema",
		"sandbox-agent-extracted-agent-schemas",
	];

	const cargoTomlPath = `${opts.root}/Cargo.toml`;
	let cargoContent = await fs.readFile(cargoTomlPath, "utf-8");

	for (const crate of internalCrates) {
		// Match: crate-name = { version = "x.y.z", path = "..." }
		const pattern = new RegExp(
			`(${crate.replace(/-/g, "-")} = \\{ version = ")[^"]+(",)`,
			"g"
		);
		cargoContent = cargoContent.replace(pattern, `$1${opts.version}$2`);
	}

	await fs.writeFile(cargoTomlPath, cargoContent);
	await $({ cwd: opts.root })`git add Cargo.toml`;

	// Substitute all files
	for (const { path: globPath, find, replace } of findReplace) {
		const paths = await glob(globPath, { cwd: opts.root });
		assert(paths.length > 0, `no paths matched: ${globPath}`);
		for (const path of paths) {
			const file = await fs.readFile(path, "utf-8");
			assert(find.test(file), `file does not match ${find}: ${path}`);
			const newFile = file.replace(find, replace);
			await fs.writeFile(path, newFile);

			await $({ cwd: opts.root })`git add ${path}`;
		}
	}
}
