import { describe, expect, it } from "vitest";
import { repoLabelFromRemote } from "./repo.js";

describe("repoLabelFromRemote", () => {
  it("keeps mock github remotes readable", () => {
    expect(repoLabelFromRemote("mockgithub://acme/backend")).toBe("acme/backend");
  });

  it("extracts owner and repo from file urls", () => {
    expect(repoLabelFromRemote("file:///tmp/mock-remotes/rivet/agents.git")).toBe("rivet/agents");
  });
});
