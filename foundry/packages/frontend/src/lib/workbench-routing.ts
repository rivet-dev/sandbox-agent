import type { TaskWorkbenchSnapshot } from "@sandbox-agent/foundry-shared";

export function resolveRepoRouteTaskId(snapshot: TaskWorkbenchSnapshot, repoId: string): string | null {
  const tasks = (snapshot as TaskWorkbenchSnapshot & { tasks?: TaskWorkbenchSnapshot["tasks"] }).tasks ?? snapshot.tasks;
  return tasks.find((task) => (task.repoIds?.length ? task.repoIds : [task.repoId]).includes(repoId))?.id ?? null;
}
