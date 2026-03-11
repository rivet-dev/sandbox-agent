import type { HandoffRecord } from "@sandbox-agent/foundry-shared";

export interface RepoGroup {
  repoId: string;
  repoRemote: string;
  handoffs: HandoffRecord[];
}

export function groupHandoffsByRepo(handoffs: HandoffRecord[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();

  for (const handoff of handoffs) {
    const group = groups.get(handoff.repoId);
    if (group) {
      group.handoffs.push(handoff);
      continue;
    }

    groups.set(handoff.repoId, {
      repoId: handoff.repoId,
      repoRemote: handoff.repoRemote,
      handoffs: [handoff],
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      handoffs: [...group.handoffs].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => {
      const aLatest = a.handoffs[0]?.updatedAt ?? 0;
      const bLatest = b.handoffs[0]?.updatedAt ?? 0;
      if (aLatest !== bLatest) {
        return bLatest - aLatest;
      }
      return a.repoRemote.localeCompare(b.repoRemote);
    });
}

export function formatDiffStat(diffStat: string | null | undefined): string {
  const normalized = diffStat?.trim();
  if (!normalized) {
    return "-";
  }
  if (normalized === "+0/-0" || normalized === "+0 -0" || normalized === "0 files changed") {
    return "No changes";
  }
  return normalized;
}
