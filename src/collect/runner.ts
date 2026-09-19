import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeHome, cursorAgentStoresDir } from "../paths.js";
import type { AppConfig, CollectResult } from "../types.js";
import type { MemoryService } from "../memory/service.js";
import { readCollected } from "./fs.js";

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
  for (const extra of config.collect.extraRoots) {
    if (!extra.trim()) continue;
    results.push(await service.ingestCollected(`extra:${extra}`, readCollected(extra)));
  }
  return results;
}
