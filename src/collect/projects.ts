import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isOversized, isProjectMemoryFile, isSkipDirName, resolveProjectScopeId } from "./scope.js";

export { isProjectMemoryFile };

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
        if (!isSkipDirName(entry.name)) stack.push(full);
        continue;
      }
      if (!isProjectMemoryFile(full)) continue;
      if (isOversized(full)) continue;
      out.push(full);
    }
  }
  return out;
}

export function readProjectMemories(root: string): Array<{ path: string; text: string; scopeId?: string }> {
  return walkProjectMemoryFiles(root).flatMap((file) => {
    try {
      return [{ path: file, text: readFileSync(file, "utf8"), scopeId: resolveProjectScopeId(file, root) }];
    } catch {
      return [];
    }
  });
}
