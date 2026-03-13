import { execSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../../..");
const frontendDist = resolve(desktopRoot, "../frontend/dist");
const destDir = resolve(desktopRoot, "frontend-dist");

function run(cmd: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  console.log(`> ${cmd}`);
  execSync(cmd, {
    stdio: "inherit",
    cwd: opts?.cwd ?? repoRoot,
    env: { ...process.env, ...opts?.env },
  });
}

// Step 1: Build the frontend for mobile (no hardcoded backend endpoint)
console.log("\n=== Building frontend for mobile ===\n");
run("pnpm --filter @sandbox-agent/foundry-frontend build", {
  env: {
    VITE_MOBILE: "1",
  },
});

// Step 2: Copy dist to frontend-dist/
console.log("\n=== Copying frontend build output ===\n");
if (existsSync(destDir)) {
  rmSync(destDir, { recursive: true });
}
cpSync(frontendDist, destDir, { recursive: true });

// Step 3: Strip react-scan script from index.html (it loads unconditionally)
const indexPath = resolve(destDir, "index.html");
let html = readFileSync(indexPath, "utf-8");
html = html.replace(/<script\s+src="https:\/\/unpkg\.com\/react-scan\/dist\/auto\.global\.js"[^>]*><\/script>\s*/g, "");
writeFileSync(indexPath, html);

console.log("\n=== Mobile frontend build complete ===\n");
