import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".sync") continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (![...TEXT_EXT].some((ext) => lower.endsWith(ext))) continue;
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

export function readCollected(root: string): Array<{ path: string; text: string; scopeId?: string }> {
  return walkTextFiles(root).flatMap((file) => {
    try {
      const text = readFileSync(file, "utf8");
      return [{ path: file, text, scopeId: relative(root, file) }];
    } catch {
      return [];
    }
  });
}
