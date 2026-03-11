import { describe, expect, it } from "vitest";
import { taskKey, taskStatusSyncKey, historyKey, repoBranchSyncKey, repoKey, repoPrSyncKey, sandboxInstanceKey, workspaceKey } from "../src/actors/keys.js";

describe("actor keys", () => {
  it("prefixes every key with workspace namespace", () => {
    const keys = [
      workspaceKey("default"),
      repoKey("default", "repo"),
      taskKey("default", "task"),
      sandboxInstanceKey("default", "daytona", "sbx"),
      historyKey("default", "repo"),
      repoPrSyncKey("default", "repo"),
      repoBranchSyncKey("default", "repo"),
      taskStatusSyncKey("default", "repo", "task", "sandbox-1", "session-1"),
    ];

    for (const key of keys) {
      expect(key[0]).toBe("ws");
      expect(key[1]).toBe("default");
    }
  });
});
