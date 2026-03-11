import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function graphiteAvailable(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync("gt", ["trunk"], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export async function graphiteGet(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("gt", ["get", branchName], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export async function graphiteCreateBranch(repoPath: string, branchName: string): Promise<void> {
  await execFileAsync("gt", ["create", branchName], { cwd: repoPath });
}

export async function graphiteCheckout(repoPath: string, branchName: string): Promise<void> {
  await execFileAsync("gt", ["checkout", branchName], { cwd: repoPath });
}

export async function graphiteSubmit(repoPath: string): Promise<void> {
  await execFileAsync("gt", ["submit", "--no-edit"], { cwd: repoPath });
}

export async function graphiteMergeBranch(repoPath: string, branchName: string): Promise<void> {
  await execFileAsync("gt", ["merge", branchName], { cwd: repoPath });
}

export async function graphiteAbandon(repoPath: string, branchName: string): Promise<void> {
  await execFileAsync("gt", ["abandon", branchName], { cwd: repoPath });
}

export interface GraphiteStackEntry {
  branchName: string;
  parentBranch: string | null;
}

export async function graphiteGetStack(repoPath: string): Promise<GraphiteStackEntry[]> {
  try {
    // Try JSON output first
    const { stdout } = await execFileAsync("gt", ["log", "--json"], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    });

    const parsed = JSON.parse(stdout) as Array<{
      branch?: string;
      name?: string;
      parent?: string;
      parentBranch?: string;
    }>;

    return parsed.map((entry) => ({
      branchName: entry.branch ?? entry.name ?? "",
      parentBranch: entry.parent ?? entry.parentBranch ?? null,
    }));
  } catch {
    // Fall back to text parsing of `gt log`
    try {
      const { stdout } = await execFileAsync("gt", ["log"], {
        cwd: repoPath,
        maxBuffer: 1024 * 1024,
      });

      const entries: GraphiteStackEntry[] = [];
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);

      // Parse indented tree output: each line has tree chars (|, /, \, -, etc.)
      // followed by branch names. Build parent-child from indentation level.
      const branchStack: string[] = [];

      for (const line of lines) {
        // Strip ANSI color codes
        const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
        // Extract branch name: skip tree characters and whitespace
        const branchMatch = clean.match(/[│├└─|/\\*\s]*(?:◉|○|●)?\s*(.+)/);
        if (!branchMatch) continue;

        const branchName = branchMatch[1]!.trim();
        if (!branchName || branchName.startsWith("(") || branchName === "") continue;

        // Determine indentation level by counting leading whitespace/tree chars
        const indent = clean.search(/[a-zA-Z0-9]/);
        const level = Math.max(0, Math.floor(indent / 2));

        // Trim stack to current level
        while (branchStack.length > level) {
          branchStack.pop();
        }

        const parentBranch = branchStack.length > 0 ? (branchStack[branchStack.length - 1] ?? null) : null;

        entries.push({ branchName, parentBranch });
        branchStack.push(branchName);
      }

      return entries;
    } catch {
      return [];
    }
  }
}

export async function graphiteGetParent(repoPath: string, branchName: string): Promise<string | null> {
  try {
    // Try `gt get <branchName>` to see parent info
    const { stdout } = await execFileAsync("gt", ["get", branchName], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    });

    // Parse output for parent branch reference
    const parentMatch = stdout.match(/parent:\s*(\S+)/i);
    if (parentMatch) {
      return parentMatch[1] ?? null;
    }
  } catch {
    // Fall through to stack-based lookup
  }

  // Fall back to stack info
  try {
    const stack = await graphiteGetStack(repoPath);
    const entry = stack.find((e) => e.branchName === branchName);
    return entry?.parentBranch ?? null;
  } catch {
    return null;
  }
}
