import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProjectMemoryFile, readProjectMemories } from "./projects.js";

describe("project memory files", () => {
  it("accepts convention files and cursor rules", () => {
    expect(isProjectMemoryFile("/repo/AGENTS.md")).toBe(true);
    expect(isProjectMemoryFile("/repo/.cursor/rules/ui.mdc")).toBe(true);
    expect(isProjectMemoryFile("/repo/README.md")).toBe(false);
  });

  it("reads only convention files from a tree", () => {
    const root = mkdtempSync(join(tmpdir(), "ol-proj-"));
    mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "Use pnpm.");
    writeFileSync(join(root, "README.md"), "ignore me");
    writeFileSync(join(root, ".cursor", "rules", "style.mdc"), "No aspect-ratio hacks.");
    writeFileSync(join(root, "node_modules", "pkg", "AGENTS.md"), "vendor");
    const files = readProjectMemories(root);
    expect(files.map((item) => item.scopeId?.replaceAll("\\", "/")).sort()).toEqual([
      ".cursor/rules/style.mdc",
      "AGENTS.md",
    ]);
  });
});
