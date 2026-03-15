import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { repositoryDb } from "./db/db.js";
import { REPOSITORY_QUEUE_NAMES, repositoryActions, runRepositoryWorkflow } from "./actions.js";

export interface RepositoryInput {
  organizationId: string;
  repoId: string;
  remoteUrl: string;
}

export const repository = actor({
  db: repositoryDb,
  queues: Object.fromEntries(REPOSITORY_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "Repository",
    icon: "folder",
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, input: RepositoryInput) => ({
    organizationId: input.organizationId,
    repoId: input.repoId,
    remoteUrl: input.remoteUrl,
  }),
  actions: repositoryActions,
  run: workflow(runRepositoryWorkflow),
});
