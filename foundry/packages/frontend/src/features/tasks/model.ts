import type { TaskRecord } from "@sandbox-agent/foundry-shared";

export interface RepoGroup {
  repoId: string;
  repoRemote: string;
  tasks: TaskRecord[];
}

export function groupTasksByRepo(tasks: TaskRecord[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();

  for (const task of tasks) {
    const linkedRepoIds = task.repoIds?.length ? task.repoIds : [task.repoId];
    for (const repoId of linkedRepoIds) {
      const group = groups.get(repoId);
      if (group) {
        group.tasks.push(task);
        group.tasks = group.tasks;
        continue;
      }

      groups.set(repoId, {
        repoId,
        repoRemote: task.repoRemote,
        tasks: [task],
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      tasks: [...group.tasks].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => {
      const aLatest = a.tasks[0]?.updatedAt ?? 0;
      const bLatest = b.tasks[0]?.updatedAt ?? 0;
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
