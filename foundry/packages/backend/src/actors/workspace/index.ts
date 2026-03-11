import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { workspaceDb } from "./db/db.js";
import { runWorkspaceWorkflow, WORKSPACE_QUEUE_NAMES, workspaceActions } from "./actions.js";

export const workspace = actor({
  db: workspaceDb,
  queues: Object.fromEntries(WORKSPACE_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, workspaceId: string) => ({
    workspaceId,
  }),
  actions: workspaceActions,
  run: workflow(runWorkspaceWorkflow),
});
