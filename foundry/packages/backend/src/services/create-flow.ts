export interface ResolveCreateFlowDecisionInput {
  task: string;
  explicitTitle?: string;
  explicitBranchName?: string;
  localBranches: string[];
  taskBranches: string[];
}

export interface ResolveCreateFlowDecisionResult {
  title: string;
  branchName: string;
}

function firstNonEmptyLine(input: string): string {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0] ?? "";
}

export function deriveFallbackTitle(task: string, explicitTitle?: string): string {
  const source = (explicitTitle && explicitTitle.trim()) || firstNonEmptyLine(task) || "update task";
  const explicitPrefixMatch = source.match(/^\s*(feat|fix|docs|refactor):\s+(.+)$/i);
  if (explicitPrefixMatch) {
    const explicitTypePrefix = explicitPrefixMatch[1]!.toLowerCase();
    const explicitSummary = explicitPrefixMatch[2]!
      .split("")
      .map((char) => (/^[a-zA-Z0-9 -]$/.test(char) ? char : " "))
      .join("")
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .join(" ")
      .slice(0, 62)
      .trim();

    return `${explicitTypePrefix}: ${explicitSummary || "update task"}`;
  }

  const lowered = source.toLowerCase();

  const typePrefix =
    lowered.includes("fix") || lowered.includes("bug")
      ? "fix"
      : lowered.includes("doc") || lowered.includes("readme")
        ? "docs"
        : lowered.includes("refactor")
          ? "refactor"
          : "feat";

  const cleaned = source
    .split("")
    .map((char) => (/^[a-zA-Z0-9 -]$/.test(char) ? char : " "))
    .join("")
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .join(" ");

  const summary = (cleaned || "update task").slice(0, 62).trim();
  return `${typePrefix}: ${summary}`.trim();
}

export function sanitizeBranchName(input: string): string {
  const normalized = input
    .toLowerCase()
    .split("")
    .map((char) => (/^[a-z0-9]$/.test(char) ? char : "-"))
    .join("");

  let result = "";
  let previousDash = false;
  for (const char of normalized) {
    if (char === "-") {
      if (!previousDash && result.length > 0) {
        result += char;
      }
      previousDash = true;
      continue;
    }

    result += char;
    previousDash = false;
  }

  const trimmed = result.replace(/-+$/g, "");
  if (trimmed.length <= 50) {
    return trimmed;
  }
  return trimmed.slice(0, 50).replace(/-+$/g, "");
}

export function resolveCreateFlowDecision(input: ResolveCreateFlowDecisionInput): ResolveCreateFlowDecisionResult {
  const explicitBranch = input.explicitBranchName?.trim();
  const title = deriveFallbackTitle(input.task, input.explicitTitle);
  const generatedBase = sanitizeBranchName(title) || "task";

  const branchBase = explicitBranch && explicitBranch.length > 0 ? explicitBranch : generatedBase;

  const existingBranches = new Set(input.localBranches.map((value) => value.trim()).filter((value) => value.length > 0));
  const existingTaskBranches = new Set(input.taskBranches.map((value) => value.trim()).filter((value) => value.length > 0));
  const conflicts = (name: string): boolean => existingBranches.has(name) || existingTaskBranches.has(name);

  if (explicitBranch && conflicts(branchBase)) {
    throw new Error(`Branch '${branchBase}' already exists. Choose a different --name/--branch value.`);
  }

  if (explicitBranch) {
    return { title, branchName: branchBase };
  }

  let candidate = branchBase;
  let index = 2;
  while (conflicts(candidate)) {
    candidate = `${branchBase}-${index}`;
    index += 1;
  }

  return {
    title,
    branchName: candidate,
  };
}
