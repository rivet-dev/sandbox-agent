import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { organizationDb } from "./db/db.js";
import { runOrganizationWorkflow, ORGANIZATION_QUEUE_NAMES, organizationActions } from "./actions.js";

export const organization = actor({
  db: organizationDb,
  queues: Object.fromEntries(ORGANIZATION_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "Organization",
    icon: "compass",
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, organizationId: string) => ({
    organizationId,
  }),
  actions: organizationActions,
  run: workflow(runOrganizationWorkflow),
});
