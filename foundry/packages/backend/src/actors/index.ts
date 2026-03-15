import { authUser } from "./auth-user/index.js";
import { setup } from "rivetkit";
import { githubData } from "./github-data/index.js";
import { task } from "./task/index.js";
import { history } from "./history/index.js";
import { repository } from "./repository/index.js";
import { taskSandbox } from "./sandbox/index.js";
import { organization } from "./organization/index.js";
import { logger } from "../logging.js";

const RUNNER_VERSION = Math.floor(Date.now() / 1000);

export const registry = setup({
  serverless: {
    basePath: "/v1/rivet",
  },
  runner: {
    version: RUNNER_VERSION,
  },
  logging: {
    baseLogger: logger,
  },
  use: {
    authUser,
    organization,
    repository,
    task,
    taskSandbox,
    history,
    githubData,
  },
});

export * from "./context.js";
export * from "./events.js";
export * from "./auth-user/index.js";
export * from "./github-data/index.js";
export * from "./task/index.js";
export * from "./history/index.js";
export * from "./keys.js";
export * from "./repository/index.js";
export * from "./sandbox/index.js";
export * from "./organization/index.js";
