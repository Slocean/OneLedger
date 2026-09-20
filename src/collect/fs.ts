import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isOversized, isSkipDirName, isToolMemoryFile, resolveProjectScopeId } from "./scope.js";

const TEXT_EXT = new Set([".md", ".txt", ".json", ".yml", ".yaml", ".mdc"]);

export function walkTextFiles(root: string, maxFiles = 400): string[] {
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
        if (!isSkipDirName(entry.name)) stack.push(full);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (![...TEXT_EXT].some((ext) => lower.endsWith(ext))) continue;
      if (!isToolMemoryFile(full)) continue;
      if (isOversized(full)) continue;
      out.push(full);
    }
  }
  return out;
}

export function readCollected(root: string): Array<{ path: string; text: string; scopeId?: string }> {
  return walkTextFiles(root).flatMap((file) => {
    try {
      const text = readFileSync(file, "utf8");
      return [{ path: file, text, scopeId: resolveProjectScopeId(file, root) }];
    } catch {
      return [];
    }
  });
}
