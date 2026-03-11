import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PullRequestSnapshot {
  number: number;
  headRefName: string;
  state: string;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  ciStatus: string | null;
  reviewStatus: string | null;
  reviewer: string | null;
}

interface GhPrListItem {
  number: number;
  headRefName: string;
  state: string;
  title: string;
  url?: string;
  author?: { login?: string };
  isDraft?: boolean;
  statusCheckRollup?: Array<{
    state?: string;
    status?: string;
    conclusion?: string;
    __typename?: string;
  }>;
  reviews?: Array<{
    state?: string;
    author?: { login?: string };
  }>;
}

function parseCiStatus(checks: GhPrListItem["statusCheckRollup"]): string | null {
  if (!checks || checks.length === 0) return null;

  let total = 0;
  let successes = 0;
  let hasRunning = false;

  for (const check of checks) {
    total++;
    const conclusion = check.conclusion?.toUpperCase();
    const state = check.state?.toUpperCase();
    const status = check.status?.toUpperCase();

    if (conclusion === "SUCCESS" || state === "SUCCESS") {
      successes++;
    } else if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || state === "PENDING") {
      hasRunning = true;
    }
  }

  if (hasRunning && successes < total) {
    return "running";
  }

  return `${successes}/${total}`;
}

function parseReviewStatus(reviews: GhPrListItem["reviews"]): { status: string | null; reviewer: string | null } {
  if (!reviews || reviews.length === 0) {
    return { status: null, reviewer: null };
  }

  // Build a map of latest review per author
  const latestByAuthor = new Map<string, { state: string; login: string }>();
  for (const review of reviews) {
    const login = review.author?.login ?? "unknown";
    const state = review.state?.toUpperCase() ?? "";
    if (state === "COMMENTED") continue; // Skip comments, only track actionable reviews
    latestByAuthor.set(login, { state, login });
  }

  // Check for CHANGES_REQUESTED first (takes priority), then APPROVED
  for (const [, entry] of latestByAuthor) {
    if (entry.state === "CHANGES_REQUESTED") {
      return { status: "CHANGES_REQUESTED", reviewer: entry.login };
    }
  }

  for (const [, entry] of latestByAuthor) {
    if (entry.state === "APPROVED") {
      return { status: "APPROVED", reviewer: entry.login };
    }
  }

  // If there are reviews but none are APPROVED or CHANGES_REQUESTED
  if (latestByAuthor.size > 0) {
    const first = latestByAuthor.values().next().value;
    return { status: "PENDING", reviewer: first?.login ?? null };
  }

  return { status: null, reviewer: null };
}

function snapshotFromGhItem(item: GhPrListItem): PullRequestSnapshot {
  const { status: reviewStatus, reviewer } = parseReviewStatus(item.reviews);
  return {
    number: item.number,
    headRefName: item.headRefName,
    state: item.state,
    title: item.title,
    url: item.url ?? "",
    author: item.author?.login ?? "",
    isDraft: item.isDraft ?? false,
    ciStatus: parseCiStatus(item.statusCheckRollup),
    reviewStatus,
    reviewer,
  };
}

const PR_JSON_FIELDS = "number,headRefName,state,title,url,author,isDraft,statusCheckRollup,reviews";

export async function listPullRequests(repoPath: string): Promise<PullRequestSnapshot[]> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "list", "--json", PR_JSON_FIELDS, "--limit", "200"], { maxBuffer: 1024 * 1024 * 4, cwd: repoPath });

    const parsed = JSON.parse(stdout) as GhPrListItem[];

    return parsed.map((item) => {
      // Handle fork PRs where headRefName may contain "owner:branch"
      const headRefName = item.headRefName.includes(":") ? (item.headRefName.split(":").pop() ?? item.headRefName) : item.headRefName;

      return snapshotFromGhItem({ ...item, headRefName });
    });
  } catch {
    return [];
  }
}

export async function getPrInfo(repoPath: string, branchName: string): Promise<PullRequestSnapshot | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", branchName, "--json", PR_JSON_FIELDS], { maxBuffer: 1024 * 1024 * 4, cwd: repoPath });

    const item = JSON.parse(stdout) as GhPrListItem;
    return snapshotFromGhItem(item);
  } catch {
    return null;
  }
}

export async function createPr(repoPath: string, headBranch: string, title: string, body?: string): Promise<{ number: number; url: string }> {
  const args = ["pr", "create", "--title", title, "--head", headBranch];
  if (body) {
    args.push("--body", body);
  } else {
    args.push("--body", "");
  }

  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 1024 * 1024,
    cwd: repoPath,
  });

  // gh pr create outputs the PR URL on success
  const url = stdout.trim();
  // Extract PR number from URL: https://github.com/owner/repo/pull/123
  const numberMatch = url.match(/\/pull\/(\d+)/);
  const number = numberMatch ? parseInt(numberMatch[1]!, 10) : 0;

  return { number, url };
}

export async function starRepository(repoFullName: string): Promise<void> {
  try {
    await execFileAsync("gh", ["api", "--method", "PUT", `user/starred/${repoFullName}`], {
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Failed to star GitHub repository ${repoFullName}. Ensure GitHub auth is configured for the backend.`;
    throw new Error(message);
  }
}

export async function getAllowedMergeMethod(repoPath: string): Promise<"squash" | "rebase" | "merge"> {
  try {
    // Get the repo owner/name from gh
    const { stdout: repoJson } = await execFileAsync("gh", ["repo", "view", "--json", "owner,name"], { cwd: repoPath });
    const repo = JSON.parse(repoJson) as { owner: { login: string }; name: string };
    const repoFullName = `${repo.owner.login}/${repo.name}`;

    const { stdout } = await execFileAsync("gh", ["api", `repos/${repoFullName}`, "--jq", ".allow_squash_merge, .allow_rebase_merge, .allow_merge_commit"], {
      maxBuffer: 1024 * 1024,
      cwd: repoPath,
    });

    const lines = stdout.trim().split("\n");
    const allowSquash = lines[0]?.trim() === "true";
    const allowRebase = lines[1]?.trim() === "true";
    const allowMerge = lines[2]?.trim() === "true";

    if (allowSquash) return "squash";
    if (allowRebase) return "rebase";
    if (allowMerge) return "merge";
    return "squash";
  } catch {
    return "squash";
  }
}

export async function mergePr(repoPath: string, prNumber: number): Promise<void> {
  const method = await getAllowedMergeMethod(repoPath);
  await execFileAsync("gh", ["pr", "merge", String(prNumber), `--${method}`, "--delete-branch"], { cwd: repoPath });
}

export async function isPrMerged(repoPath: string, branchName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", branchName, "--json", "state"], { cwd: repoPath });
    const parsed = JSON.parse(stdout) as { state: string };
    return parsed.state.toUpperCase() === "MERGED";
  } catch {
    return false;
  }
}

export async function getPrTitle(repoPath: string, branchName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", branchName, "--json", "title"], { cwd: repoPath });
    const parsed = JSON.parse(stdout) as { title: string };
    return parsed.title;
  } catch {
    return null;
  }
}
