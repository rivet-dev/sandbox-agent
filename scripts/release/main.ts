#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import readline from "node:readline";

const ENDPOINT_URL =
  "https://2a94c6a0ced8d35ea63cddc86c2681e7.r2.cloudflarestorage.com";
const BUCKET = "rivet-releases";
const PREFIX = "sandbox-agent";

const BINARY_FILES = [
  "sandbox-agent-x86_64-unknown-linux-musl",
  "sandbox-agent-x86_64-pc-windows-gnu.exe",
  "sandbox-agent-x86_64-apple-darwin",
  "sandbox-agent-aarch64-apple-darwin",
];

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

const STEPS = [
  "confirm-release",
  "update-version",
  "generate-artifacts",
  "git-commit",
  "git-push",
  "trigger-workflow",
  "run-checks",
  "publish-crates",
  "publish-npm-sdk",
  "publish-npm-cli",
  "upload-typescript",
  "upload-install",
  "upload-binaries",
] as const;

const PHASES = ["setup-local", "setup-ci", "complete-ci"] as const;

type Step = (typeof STEPS)[number];
type Phase = (typeof PHASES)[number];

const PHASE_MAP: Record<Phase, Step[]> = {
  "setup-local": [
    "confirm-release",
    "update-version",
    "generate-artifacts",
    "git-commit",
    "git-push",
    "trigger-workflow",
  ],
  "setup-ci": ["run-checks"],
  "complete-ci": [
    "publish-crates",
    "publish-npm-sdk",
    "publish-npm-cli",
    "upload-typescript",
    "upload-install",
    "upload-binaries",
  ],
};

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    if (arg.includes("=")) {
      const [key, value] = arg.split("=");
      args.set(key, value ?? "");
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(arg, next);
      i += 1;
    } else {
      flags.add(arg);
    }
  }
  return { args, flags };
}

function run(cmd: string, cmdArgs: string[], options: Record<string, any> = {}) {
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCapture(cmd: string, cmdArgs: string[], options: Record<string, any> = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? String(result.stderr).trim() : "";
    throw new Error(`${cmd} failed: ${stderr}`);
  }
  return (result.stdout || "").toString().trim();
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver {
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/,
  );
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isStable(version: string) {
  return parseSemver(version).prerelease.length === 0;
}

function getNpmTag(version: string, latest: boolean) {
  if (latest) return null;
  const prerelease = parseSemver(version).prerelease;
  if (prerelease.length === 0) {
    return "next";
  }
  const hasRc = prerelease.some((part) => part.toLowerCase().startsWith("rc"));
  if (hasRc) {
    return "rc";
  }
  throw new Error(`Prerelease versions must use rc tag when not latest: ${version}`);
}

function getAllGitVersions() {
  try {
    execFileSync("git", ["fetch", "--tags", "--force", "--quiet"], {
      stdio: "ignore",
    });
  } catch {
    // best-effort
  }

  const output = runCapture("git", ["tag", "-l", "v*"]);
  if (!output) return [];

  return output
    .split("\n")
    .map((tag) => tag.replace(/^v/, ""))
    .filter((tag) => {
      try {
        parseSemver(tag);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => compareSemver(parseSemver(b), parseSemver(a)));
}

function getLatestStableVersion() {
  const versions = getAllGitVersions();
  const stable = versions.filter((version) => isStable(version));
  return stable[0] || null;
}

function shouldTagAsLatest(version: string) {
  const parsed = parseSemver(version);
  if (parsed.prerelease.length > 0) {
    return false;
  }

  const latestStable = getLatestStableVersion();
  if (!latestStable) {
    return true;
  }

  return compareSemver(parsed, parseSemver(latestStable)) > 0;
}

function getAwsEnv() {
  const accessKey =
    process.env.AWS_ACCESS_KEY_ID || process.env.R2_RELEASES_ACCESS_KEY_ID;
  const secretKey =
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.R2_RELEASES_SECRET_ACCESS_KEY;

  if (!accessKey || !secretKey) {
    throw new Error("Missing AWS credentials for releases bucket");
  }

  return {
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
    AWS_DEFAULT_REGION: "auto",
  };
}

function uploadDir(localPath: string, remotePath: string) {
  const env = { ...process.env, ...getAwsEnv() };
  run(
    "aws",
    [
      "s3",
      "cp",
      localPath,
      `s3://${BUCKET}/${remotePath}`,
      "--recursive",
      "--checksum-algorithm",
      "CRC32",
      "--endpoint-url",
      ENDPOINT_URL,
    ],
    { env },
  );
}

function uploadFile(localPath: string, remotePath: string) {
  const env = { ...process.env, ...getAwsEnv() };
  run(
    "aws",
    [
      "s3",
      "cp",
      localPath,
      `s3://${BUCKET}/${remotePath}`,
      "--checksum-algorithm",
      "CRC32",
      "--endpoint-url",
      ENDPOINT_URL,
    ],
    { env },
  );
}

function uploadContent(content: string, remotePath: string) {
  const env = { ...process.env, ...getAwsEnv() };
  const result = spawnSync(
    "aws",
    [
      "s3",
      "cp",
      "-",
      `s3://${BUCKET}/${remotePath}`,
      "--endpoint-url",
      ENDPOINT_URL,
    ],
    {
      env,
      input: content,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function updatePackageJson(filePath: string, version: string, updateOptionalDeps = false) {
  const pkg = JSON.parse(fs.readFileSync(filePath, "utf8"));
  pkg.version = version;
  if (updateOptionalDeps && pkg.optionalDependencies) {
    for (const dep of Object.keys(pkg.optionalDependencies)) {
      pkg.optionalDependencies[dep] = version;
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
}

function updateVersion(rootDir: string, version: string) {
  const cargoPath = path.join(rootDir, "Cargo.toml");
  let cargoContent = fs.readFileSync(cargoPath, "utf8");
  cargoContent = cargoContent.replace(/^version = ".*"/m, `version = "${version}"`);
  fs.writeFileSync(cargoPath, cargoContent);

  updatePackageJson(path.join(rootDir, "sdks", "typescript", "package.json"), version, true);
  updatePackageJson(path.join(rootDir, "sdks", "cli", "package.json"), version, true);

  const platformsDir = path.join(rootDir, "sdks", "cli", "platforms");
  for (const entry of fs.readdirSync(platformsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(platformsDir, entry.name, "package.json");
    if (fs.existsSync(pkgPath)) {
      updatePackageJson(pkgPath, version, false);
    }
  }
}

function buildTypescript(rootDir: string) {
  const sdkDir = path.join(rootDir, "sdks", "typescript");
  if (!fs.existsSync(sdkDir)) {
    throw new Error(`TypeScript SDK not found at ${sdkDir}`);
  }
  run("pnpm", ["install"], { cwd: sdkDir });
  run("pnpm", ["run", "build"], { cwd: sdkDir });
  return path.join(sdkDir, "dist");
}

function generateArtifacts(rootDir: string) {
  run("pnpm", ["install"], { cwd: rootDir });
  run("pnpm", ["--filter", "@sandbox-agent/inspector", "build"], {
    cwd: rootDir,
    env: { ...process.env, SANDBOX_AGENT_SKIP_INSPECTOR: "1" },
  });
  const sdkDir = path.join(rootDir, "sdks", "typescript");
  run("pnpm", ["run", "generate"], { cwd: sdkDir });
  run("cargo", ["check", "-p", "sandbox-agent-universal-schema-gen"], { cwd: rootDir });
  run("cargo", ["run", "-p", "sandbox-agent-openapi-gen", "--", "--out", "docs/openapi.json"], {
    cwd: rootDir,
  });
}

function uploadTypescriptArtifacts(rootDir: string, version: string, latest: boolean) {
  console.log("==> Building TypeScript SDK");
  const distPath = buildTypescript(rootDir);

  console.log("==> Uploading TypeScript artifacts");
  uploadDir(distPath, `${PREFIX}/${version}/typescript/`);
  if (latest) {
    uploadDir(distPath, `${PREFIX}/latest/typescript/`);
  }
}

function uploadInstallScript(rootDir: string, version: string, latest: boolean) {
  const installPath = path.join(rootDir, "scripts", "release", "static", "install.sh");
  let installContent = fs.readFileSync(installPath, "utf8");

  const uploadForVersion = (versionValue: string, remoteVersion: string) => {
    const content = installContent.replace(/__VERSION__/g, versionValue);
    uploadContent(content, `${PREFIX}/${remoteVersion}/install.sh`);
  };

  uploadForVersion(version, version);
  if (latest) {
    uploadForVersion("latest", "latest");
  }
}

function uploadBinaries(rootDir: string, version: string, latest: boolean) {
  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(`dist directory not found at ${distDir}`);
  }

  for (const fileName of BINARY_FILES) {
    const localPath = path.join(distDir, fileName);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Missing binary: ${localPath}`);
    }

    uploadFile(localPath, `${PREFIX}/${version}/${fileName}`);
    if (latest) {
      uploadFile(localPath, `${PREFIX}/latest/${fileName}`);
    }
  }
}

function runChecks(rootDir: string) {
  console.log("==> Installing Node dependencies");
  run("pnpm", ["install"], { cwd: rootDir });

  console.log("==> Building inspector frontend");
  run("pnpm", ["--filter", "@sandbox-agent/inspector", "build"], {
    cwd: rootDir,
    env: { ...process.env, SANDBOX_AGENT_SKIP_INSPECTOR: "1" },
  });

  console.log("==> Running Rust checks");
  run("cargo", ["fmt", "--all", "--", "--check"], { cwd: rootDir });
  run("cargo", ["clippy", "--all-targets", "--", "-D", "warnings"], { cwd: rootDir });
  run("cargo", ["test", "--all-targets"], { cwd: rootDir });

  console.log("==> Running TypeScript checks");
  run("pnpm", ["run", "build"], { cwd: rootDir });

  console.log("==> Running TypeScript SDK tests");
  run("pnpm", ["--filter", "sandbox-agent", "test"], { cwd: rootDir });

  console.log("==> Running CLI SDK tests");
  run("pnpm", ["--filter", "@sandbox-agent/cli", "test"], { cwd: rootDir });

  console.log("==> Validating OpenAPI spec for Mintlify");
  run("pnpm", ["dlx", "mint", "openapi-check", "docs/openapi.json"], { cwd: rootDir });
}

function publishCrates(rootDir: string, version: string) {
  updateVersion(rootDir, version);

  for (const crate of CRATE_ORDER) {
    console.log(`==> Publishing sandbox-agent-${crate}`);
    const crateDir = path.join(rootDir, "server", "packages", crate);
    run("cargo", ["publish", "--allow-dirty"], { cwd: crateDir });
    console.log("Waiting 30s for index...");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  }
}

function publishNpmSdk(rootDir: string, version: string, latest: boolean) {
  const sdkDir = path.join(rootDir, "sdks", "typescript");
  console.log("==> Publishing TypeScript SDK to npm");
  const npmTag = getNpmTag(version, latest);
  run("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: sdkDir });
  run("pnpm", ["install"], { cwd: sdkDir });
  run("pnpm", ["run", "build"], { cwd: sdkDir });
  const publishArgs = ["publish", "--access", "public"];
  if (npmTag) publishArgs.push("--tag", npmTag);
  run("npm", publishArgs, { cwd: sdkDir });
}

function publishNpmCli(rootDir: string, version: string, latest: boolean) {
  const cliDir = path.join(rootDir, "sdks", "cli");
  const distDir = path.join(rootDir, "dist");
  const npmTag = getNpmTag(version, latest);

  for (const [target, info] of Object.entries(PLATFORM_MAP)) {
    const platformDir = path.join(cliDir, "platforms", info.pkg);
    const binDir = path.join(platformDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const srcBinary = path.join(distDir, `sandbox-agent-${target}${info.ext}`);
    const dstBinary = path.join(binDir, `sandbox-agent${info.ext}`);
    fs.copyFileSync(srcBinary, dstBinary);
    if (info.ext !== ".exe") fs.chmodSync(dstBinary, 0o755);

    console.log(`==> Publishing @sandbox-agent/cli-${info.pkg}`);
    run("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: platformDir });
    const publishArgs = ["publish", "--access", "public"];
    if (npmTag) publishArgs.push("--tag", npmTag);
    run("npm", publishArgs, { cwd: platformDir });
  }

  console.log("==> Publishing @sandbox-agent/cli");
  const pkgPath = path.join(cliDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  for (const dep of Object.keys(pkg.optionalDependencies || {})) {
    pkg.optionalDependencies[dep] = version;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const publishArgs = ["publish", "--access", "public"];
  if (npmTag) publishArgs.push("--tag", npmTag);
  run("npm", publishArgs, { cwd: cliDir });
}

function validateGit(rootDir: string) {
  const status = runCapture("git", ["status", "--porcelain"], { cwd: rootDir });
  if (status.trim()) {
    throw new Error("Working tree is dirty; commit or stash changes before release.");
  }
}

async function confirmRelease(version: string, latest: boolean) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Release ${version} (latest=${latest})? (yes/no): `, resolve);
  });
  rl.close();
  if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
    console.log("Release cancelled");
    process.exit(0);
  }
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const versionArg = args.get("--version");
  if (!versionArg) {
    console.error("--version is required");
    process.exit(1);
  }

  const version = versionArg.replace(/^v/, "");
  parseSemver(version);

  let latest: boolean;
  if (flags.has("--latest")) {
    latest = true;
  } else if (flags.has("--no-latest")) {
    latest = false;
  } else {
    latest = shouldTagAsLatest(version);
  }

  const outputPath = args.get("--output");
  if (flags.has("--print-latest")) {
    if (outputPath) {
      fs.appendFileSync(outputPath, `latest=${latest}\n`);
    } else {
      process.stdout.write(latest ? "true" : "false");
    }
  }

  const phaseArg = args.get("--phase");
  const stepsArg = args.get("--only-steps");
  const requestedSteps = new Set<Step>();

  if (phaseArg || stepsArg) {
    if (phaseArg && stepsArg) {
      throw new Error("Cannot use both --phase and --only-steps");
    }

    if (phaseArg) {
      const phases = phaseArg.split(",").map((value) => value.trim());
      for (const phase of phases) {
        if (!PHASES.includes(phase as Phase)) {
          throw new Error(`Invalid phase: ${phase}`);
        }
        for (const step of PHASE_MAP[phase as Phase]) {
          requestedSteps.add(step);
        }
      }
    }

    if (stepsArg) {
      const steps = stepsArg.split(",").map((value) => value.trim());
      for (const step of steps) {
        if (!STEPS.includes(step as Step)) {
          throw new Error(`Invalid step: ${step}`);
        }
        requestedSteps.add(step as Step);
      }
    }
  }

  const rootDir = process.cwd();
  const shouldRun = (step: Step) => requestedSteps.has(step);
  const hasPhases = requestedSteps.size > 0;

  if (!hasPhases) {
    if (flags.has("--check")) {
      runChecks(rootDir);
    }
    if (flags.has("--publish-crates")) {
      publishCrates(rootDir, version);
    }
    if (flags.has("--publish-npm-sdk")) {
      publishNpmSdk(rootDir, version, latest);
    }
    if (flags.has("--publish-npm-cli")) {
      publishNpmCli(rootDir, version, latest);
    }
    if (flags.has("--upload-typescript")) {
      uploadTypescriptArtifacts(rootDir, version, latest);
    }
    if (flags.has("--upload-install")) {
      uploadInstallScript(rootDir, version, latest);
    }
    if (flags.has("--upload-binaries")) {
      uploadBinaries(rootDir, version, latest);
    }
    return;
  }

  if (shouldRun("confirm-release") && !flags.has("--no-confirm")) {
    await confirmRelease(version, latest);
  }

  const validateGitEnabled = !flags.has("--no-validate-git");
  if ((shouldRun("git-commit") || shouldRun("git-push")) && validateGitEnabled) {
    validateGit(rootDir);
  }

  if (shouldRun("update-version")) {
    console.log("==> Updating versions");
    updateVersion(rootDir, version);
  }

  if (shouldRun("generate-artifacts")) {
    console.log("==> Generating OpenAPI and universal schemas");
    generateArtifacts(rootDir);
  }

  if (shouldRun("git-commit")) {
    console.log("==> Committing changes");
    run("git", ["add", "."], { cwd: rootDir });
    run("git", ["commit", "--allow-empty", "-m", `chore(release): update version to ${version}`], {
      cwd: rootDir,
    });
  }

  if (shouldRun("git-push")) {
    console.log("==> Pushing changes");
    const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: rootDir });
    if (branch === "main") {
      run("git", ["push"], { cwd: rootDir });
    } else {
      run("git", ["push", "-u", "origin", "HEAD"], { cwd: rootDir });
    }
  }

  if (shouldRun("trigger-workflow")) {
    console.log("==> Triggering release workflow");
    const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: rootDir });
    const latestFlag = latest ? "true" : "false";
    run(
      "gh",
      [
        "workflow",
        "run",
        ".github/workflows/release.yaml",
        "-f",
        `version=${version}`,
        "-f",
        `latest=${latestFlag}`,
        "--ref",
        branch,
      ],
      { cwd: rootDir },
    );
  }

  if (shouldRun("run-checks")) {
    runChecks(rootDir);
  }

  if (shouldRun("publish-crates")) {
    publishCrates(rootDir, version);
  }

  if (shouldRun("publish-npm-sdk")) {
    publishNpmSdk(rootDir, version, latest);
  }

  if (shouldRun("publish-npm-cli")) {
    publishNpmCli(rootDir, version, latest);
  }

  if (shouldRun("upload-typescript")) {
    uploadTypescriptArtifacts(rootDir, version, latest);
  }

  if (shouldRun("upload-install")) {
    uploadInstallScript(rootDir, version, latest);
  }

  if (shouldRun("upload-binaries")) {
    uploadBinaries(rootDir, version, latest);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
