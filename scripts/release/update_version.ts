import * as fs from "node:fs/promises";
import { glob } from "glob";
import { $ } from "execa";
import type { ReleaseOpts } from "./main.js";
import { assert } from "./utils.js";

export async function updateVersion(opts: ReleaseOpts) {
	const findReplace = [
		{
			path: "Cargo.toml",
			find: /^version = ".*"/m,
			replace: `version = "${opts.version}"`,
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

	for (const { path: globPath, find, replace } of findReplace) {
		const paths = await glob(globPath, { cwd: opts.root });
		assert(paths.length > 0, `no paths matched: ${globPath}`);

		for (const filePath of paths) {
			const fullPath = `${opts.root}/${filePath}`;
			const file = await fs.readFile(fullPath, "utf-8");
			assert(find.test(file), `file does not match ${find}: ${filePath}`);

			const newFile = file.replace(find, replace);
			await fs.writeFile(fullPath, newFile);

			await $({ cwd: opts.root })`git add ${filePath}`;
		}
	}

	// Update optionalDependencies in CLI package.json
	const cliPkgPath = `${opts.root}/sdks/cli/package.json`;
	const cliPkg = JSON.parse(await fs.readFile(cliPkgPath, "utf-8"));
	if (cliPkg.optionalDependencies) {
		for (const dep of Object.keys(cliPkg.optionalDependencies)) {
			cliPkg.optionalDependencies[dep] = opts.version;
		}
		await fs.writeFile(cliPkgPath, JSON.stringify(cliPkg, null, 2) + "\n");
		await $({ cwd: opts.root })`git add sdks/cli/package.json`;
	}

	// Update optionalDependencies in TypeScript SDK package.json
	const sdkPkgPath = `${opts.root}/sdks/typescript/package.json`;
	const sdkPkg = JSON.parse(await fs.readFile(sdkPkgPath, "utf-8"));
	if (sdkPkg.optionalDependencies) {
		for (const dep of Object.keys(sdkPkg.optionalDependencies)) {
			sdkPkg.optionalDependencies[dep] = opts.version;
		}
		await fs.writeFile(sdkPkgPath, JSON.stringify(sdkPkg, null, 2) + "\n");
		await $({ cwd: opts.root })`git add sdks/typescript/package.json`;
	}
}
