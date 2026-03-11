export interface StackEntry {
  branchName: string;
  parentBranch: string | null;
}

export interface OrderedBranchRow {
  branchName: string;
  parentBranch: string | null;
  updatedAt: number;
}

export function normalizeParentBranch(branchName: string, parentBranch: string | null | undefined): string | null {
  const parent = parentBranch?.trim() || null;
  if (!parent || parent === branchName) {
    return null;
  }
  return parent;
}

export function parentLookupFromStack(entries: StackEntry[]): Map<string, string | null> {
  const lookup = new Map<string, string | null>();
  for (const entry of entries) {
    const branchName = entry.branchName.trim();
    if (!branchName) {
      continue;
    }
    lookup.set(branchName, normalizeParentBranch(branchName, entry.parentBranch));
  }
  return lookup;
}

export function sortBranchesForOverview(rows: OrderedBranchRow[]): OrderedBranchRow[] {
  const byName = new Map(rows.map((row) => [row.branchName, row]));
  const depthMemo = new Map<string, number>();
  const computing = new Set<string>();

  const depthFor = (branchName: string): number => {
    const cached = depthMemo.get(branchName);
    if (cached != null) {
      return cached;
    }
    if (computing.has(branchName)) {
      return 999;
    }

    computing.add(branchName);
    const row = byName.get(branchName);
    const parent = row?.parentBranch;
    let depth = 0;
    if (parent && parent !== branchName && byName.has(parent)) {
      depth = Math.min(998, depthFor(parent) + 1);
    }
    computing.delete(branchName);
    depthMemo.set(branchName, depth);
    return depth;
  };

  return [...rows].sort((a, b) => {
    const da = depthFor(a.branchName);
    const db = depthFor(b.branchName);
    if (da !== db) {
      return da - db;
    }
    if (a.updatedAt !== b.updatedAt) {
      return b.updatedAt - a.updatedAt;
    }
    return a.branchName.localeCompare(b.branchName);
  });
}
