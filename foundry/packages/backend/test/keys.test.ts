import { describe, expect, it } from "vitest";
import {
  handoffKey,
  handoffStatusSyncKey,
  historyKey,
  projectBranchSyncKey,
  projectKey,
  projectPrSyncKey,
  sandboxInstanceKey,
  workspaceKey,
} from "../src/actors/keys.js";

describe("actor keys", () => {
  it("prefixes every key with workspace namespace", () => {
    const keys = [
      workspaceKey("default"),
      projectKey("default", "repo"),
      handoffKey("default", "repo", "handoff"),
      sandboxInstanceKey("default", "daytona", "sbx"),
      historyKey("default", "repo"),
      projectPrSyncKey("default", "repo"),
      projectBranchSyncKey("default", "repo"),
      handoffStatusSyncKey("default", "repo", "handoff", "sandbox-1", "session-1"),
    ];

    for (const key of keys) {
      expect(key[0]).toBe("ws");
      expect(key[1]).toBe("default");
    }
  });
});
