import { describe, expect, it } from "vitest";
import { resolveEventListOffset } from "../src/actors/sandbox-instance/persist.js";

describe("sandbox-instance persist event offset", () => {
  it("returns newest tail when cursor is omitted", () => {
    expect(resolveEventListOffset({ total: 180, limit: 50 })).toBe(130);
  });

  it("returns zero when total rows are below page size", () => {
    expect(resolveEventListOffset({ total: 20, limit: 50 })).toBe(0);
  });

  it("uses explicit cursor when provided", () => {
    expect(resolveEventListOffset({ cursor: "7", total: 180, limit: 50 })).toBe(7);
  });

  it("normalizes invalid cursors to zero", () => {
    expect(resolveEventListOffset({ cursor: "-3", total: 180, limit: 50 })).toBe(0);
    expect(resolveEventListOffset({ cursor: "not-a-number", total: 180, limit: 50 })).toBe(0);
  });
});
