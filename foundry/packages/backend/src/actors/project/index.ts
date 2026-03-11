import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { projectDb } from "./db/db.js";
import { PROJECT_QUEUE_NAMES, projectActions, runProjectWorkflow } from "./actions.js";

export interface ProjectInput {
  workspaceId: string;
  repoId: string;
  remoteUrl: string;
}

export const project = actor({
  db: projectDb,
  queues: Object.fromEntries(PROJECT_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, input: ProjectInput) => ({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    remoteUrl: input.remoteUrl,
    localPath: null as string | null,
    syncActorsStarted: false,
    handoffIndexHydrated: false,
  }),
  actions: projectActions,
  run: workflow(runProjectWorkflow),
});
