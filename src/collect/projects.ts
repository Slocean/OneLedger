import { basename, dirname, join, relative } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".sync",
  ".next",
  "coverage",
  "extensions",
]);

const EXACT_NAMES = new Set([
  "agents.md",
  "claude.md",
  "claude.local.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "gemini.md",
]);

export function isProjectMemoryFile(filePath: string): boolean {
  const name = basename(filePath).toLowerCase();
  if (EXACT_NAMES.has(name)) return true;
  const parent = basename(dirname(filePath)).toLowerCase();
  const grand = basename(dirname(dirname(filePath))).toLowerCase();
  if ((name.endsWith(".md") || name.endsWith(".mdc")) && parent === "rules" && grand === ".cursor") {
    return true;
  }
  return false;
}

export function walkProjectMemoryFiles(root: string, maxFiles = 200): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!isProjectMemoryFile(full)) continue;
      try {
        if (statSync(full).size > 256_000) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

export function readProjectMemories(root: string): Array<{ path: string; text: string; scopeId?: string }> {
  return walkProjectMemoryFiles(root).flatMap((file) => {
    try {
      return [{ path: file, text: readFileSync(file, "utf8"), scopeId: relative(root, file) }];
    } catch {
      return [];
    }
  });
}
