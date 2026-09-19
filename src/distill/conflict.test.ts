import { describe, expect, it } from "vitest";
import { findConflicts, overlapRatio, shouldAutoPromote, tokenSet } from "./conflict.js";

describe("conflict distill", () => {
  it("scores overlapping notes", () => {
    const score = overlapRatio(tokenSet("always use pnpm in this monorepo"), tokenSet("use pnpm in this monorepo"));
    expect(score).toBeGreaterThan(0.45);
  });

  it("auto-promotes only clean project sources", () => {
    expect(
      shouldAutoPromote({ source: "project:E:/x", sensitivity: "public", conflicts: [] }),
    ).toBe(true);
    expect(
      shouldAutoPromote({ source: "mcp:agent", sensitivity: "public", conflicts: [] }),
    ).toBe(false);
  });

  it("finds conflicting active memories", () => {
    const hits = findConflicts("Always use pnpm for installs", "pnpm", [
      {
        id: "mem_1",
        rev: 1,
        title: "package manager",
        body: "Always use pnpm for installs in this repo",
        scopeKind: "project",
        scopeId: "x",
        sensitivity: "public",
        status: "active",
        source: "ui",
        originNode: "a",
        contentHash: "h",
        supersededBy: null,
        createdAt: "",
        updatedAt: "",
        forgottenAt: null,
      },
    ]);
    expect(hits.map((item) => item.id)).toEqual(["mem_1"]);
  });
});
