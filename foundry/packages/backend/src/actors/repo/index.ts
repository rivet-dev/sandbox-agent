import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { repoDb } from "./db/db.js";
import { REPO_QUEUE_NAMES, repoActions, runRepoWorkflow } from "./actions.js";

export interface RepoInput {
  workspaceId: string;
  repoId: string;
  remoteUrl: string;
}

export const repo = actor({
  db: repoDb,
  queues: Object.fromEntries(REPO_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, input: RepoInput) => ({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    remoteUrl: input.remoteUrl,
    localPath: null as string | null,
    syncActorsStarted: false,
    taskIndexHydrated: false,
  }),
  actions: repoActions,
  run: workflow(runRepoWorkflow),
});
