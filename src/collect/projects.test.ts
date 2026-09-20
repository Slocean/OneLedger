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

  it("reads only convention files and scopes them to the repository name", () => {
    const root = mkdtempSync(join(tmpdir(), "ol-proj-"));
    const repo = join(root, "CofoeAirLink_Web");
    mkdirSync(join(repo, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "vendor_imports", "pkg"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "Use pnpm.");
    writeFileSync(join(repo, "README.md"), "ignore me");
    writeFileSync(join(repo, ".cursor", "rules", "style.mdc"), "No aspect-ratio hacks.");
    writeFileSync(join(root, "node_modules", "pkg", "AGENTS.md"), "vendor");
    writeFileSync(join(root, "vendor_imports", "pkg", "AGENTS.md"), "mirror");
    const files = readProjectMemories(root);
    expect(files.map((item) => item.scopeId).sort()).toEqual(["CofoeAirLink_Web", "CofoeAirLink_Web"]);
    expect(files.every((item) => !item.scopeId?.includes("AGENTS.md"))).toBe(true);
  });
});
