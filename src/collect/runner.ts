import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeHome, cursorAgentStoresDir, toolHome } from "../paths.js";
import type { AppConfig, CollectResult } from "../types.js";
import type { MemoryService } from "../memory/service.js";
import { readCollected } from "./fs.js";
import { readProjectMemories } from "./projects.js";

export async function runCollectors(service: MemoryService, config: AppConfig): Promise<CollectResult[]> {
  const results: CollectResult[] = [];
  if (config.collect.cursor) {
    const root = cursorAgentStoresDir();
    results.push(await service.ingestCollected("cursor", existsSync(root) ? readCollected(root) : []));
  }
  if (config.collect.claude) {
    const root = join(claudeHome(), "projects");
    results.push(await service.ingestCollected("claude", existsSync(root) ? readCollected(root) : []));
  }
  if (config.collect.codex) {
    const root = toolHome(".codex", "CODEX_HOME");
    results.push(await service.ingestCollected("codex", existsSync(root) ? readCollected(root) : []));
  }
  if (config.collect.continue) {
    const root = toolHome(".continue", "CONTINUE_HOME");
    results.push(await service.ingestCollected("continue", existsSync(root) ? readCollected(root) : []));
  }
  if (config.collect.projects) {
    const roots = config.collect.extraRoots.filter((item) => item.trim());
    if (roots.length === 0 && existsSync(process.cwd())) {
      roots.push(process.cwd());
    }
    for (const root of roots) {
      results.push(await service.ingestCollected(`project:${root}`, readProjectMemories(root)));
    }
  }
  return results;
}
