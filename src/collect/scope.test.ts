import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCollected } from "./fs.js";
import { isProjectMemoryFile, isToolMemoryFile, resolveProjectScopeId } from "./scope.js";

describe("collection scope and whitelist", () => {
  it("accepts convention files and workbuddy/session summaries", () => {
    expect(isProjectMemoryFile("/repo/AGENTS.md")).toBe(true);
    expect(isToolMemoryFile("/home/.workbuddy/memory/note.md")).toBe(true);
    expect(isToolMemoryFile("/home/.codex/sessions/abc/summary.md")).toBe(true);
    expect(isToolMemoryFile("/home/.zcode/workspace/x/sessions/y/pages.json")).toBe(false);
    expect(isToolMemoryFile("/home/.zcode/vendor_imports/skills/LICENSE.txt")).toBe(false);
  });

  it("resolves scopeId to a repository name, not a file path", () => {
    expect(resolveProjectScopeId("D:/PROJECT/CofoeAirLink_Web/AGENTS.md", "D:/PROJECT")).toBe("CofoeAirLink_Web");
    expect(
      resolveProjectScopeId("C:/Users/me/.workbuddy/workspace/RollTheWarTable/memory/note.md", "C:/Users/me/.workbuddy"),
    ).toBe("RollTheWarTable");
    expect(
      resolveProjectScopeId(
        "C:/Users/me/.cursor/AgentStores/d-PROJECT-CofoeAirLink_Web/sessions/summary.md",
        "C:/Users/me/.cursor/AgentStores",
      ),
    ).toBe("CofoeAirLink_Web");
  });

  it("skips caches and vendor dumps while keeping project convention files", () => {
    const root = mkdtempSync(join(tmpdir(), "ol-scope-"));
    mkdirSync(join(root, "CofoeAirLink_Web", ".cursor", "rules"), { recursive: true });
    mkdirSync(join(root, "vendor_imports", "skills"), { recursive: true });
    mkdirSync(join(root, "site-packages", "pkg"), { recursive: true });
    mkdirSync(join(root, "modify_backup"), { recursive: true });
    mkdirSync(join(root, "workspace", "RollTheWarTable", "memory"), { recursive: true });
    mkdirSync(join(root, "workspace", "sessions", "abc"), { recursive: true });
    writeFileSync(join(root, "CofoeAirLink_Web", "AGENTS.md"), "Use pnpm.");
    writeFileSync(join(root, "CofoeAirLink_Web", ".cursor", "rules", "style.mdc"), "No aspect-ratio hacks.");
    writeFileSync(join(root, "vendor_imports", "skills", "LICENSE.txt"), "MIT license text here.");
    writeFileSync(join(root, "site-packages", "pkg", "readme.md"), "python package");
    writeFileSync(join(root, "modify_backup", "note.md"), "stale backup text");
    writeFileSync(join(root, "workspace", "RollTheWarTable", "memory", "note.md"), "Prefer workbuddy notes.");
    writeFileSync(join(root, "workspace", "sessions", "abc", "pages.json"), "{\"pages\":[]}");
    const files = readCollected(root);
    const scoped = files.map((item) => item.scopeId).sort();
    expect(scoped).toEqual(["CofoeAirLink_Web", "CofoeAirLink_Web", "RollTheWarTable"]);
    expect(files.some((item) => item.path.includes("vendor_imports"))).toBe(false);
    expect(files.some((item) => item.path.endsWith("pages.json"))).toBe(false);
  });
});
