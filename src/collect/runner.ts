import type { AppConfig, CollectResult } from "../types.js";
import type { AgentRecord } from "../types.js";
import type { MemoryService } from "../memory/service.js";
import type { Store } from "../memory/store.js";
import { nowIso } from "../util.js";
import { readCollected } from "./fs.js";
import { readProjectMemories } from "./projects.js";
import { builtinBlueprints, pathExists, toAgentRecord } from "./catalog.js";
import type { CollectProgress } from "./progress.js";

export async function ensureAgents(store: Store, config: AppConfig): Promise<void> {
  const existing = new Set((await store.listAgents()).map((item) => item.id));
  for (const blueprint of builtinBlueprints(config)) {
    if (existing.has(blueprint.id)) continue;
    await store.upsertAgent(toAgentRecord(blueprint));
  }
}

export async function collectAgent(service: MemoryService, store: Store, agent: AgentRecord): Promise<CollectResult> {
  try {
    const files =
      agent.kind === "project"
        ? readProjectMemories(agent.rootPath)
        : pathExists(agent.rootPath)
          ? readCollected(agent.rootPath)
          : [];
    const result = await service.ingestCollected(agent.id, files);
    await store.upsertAgent({
      ...agent,
      lastScannedAt: nowIso(),
      lastScannedFiles: result.scannedFiles,
      lastIngested: result.ingested,
      lastQueued: result.queued,
      lastRedacted: result.redacted,
      lastError: pathExists(agent.rootPath) ? "" : "路径不存在",
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.upsertAgent({
      ...agent,
      lastScannedAt: nowIso(),
      lastError: message,
    });
    return {
      source: agent.id,
      scannedFiles: 0,
      ingested: 0,
      queued: 0,
      skipped: 0,
      redacted: 0,
    };
  }
}

export async function runCollectors(
  service: MemoryService,
  store: Store,
  config: AppConfig,
): Promise<CollectResult[]> {
  return runCollectorsWithProgress(service, store, config);
}

export async function runCollectorsWithProgress(
  service: MemoryService,
  store: Store,
  config: AppConfig,
  progress?: CollectProgress,
): Promise<CollectResult[]> {
  if (progress) {
    progress.running = true;
    progress.phase = "scanning";
    progress.message = progress.message || "正在扫描本地记忆…";
  }
  try {
    await ensureAgents(store, config);
    const results: CollectResult[] = [];
    for (const agent of await store.listAgents()) {
      if (!agent.enabled) continue;
      if (progress) {
        progress.currentAgent = agent.name;
        progress.message = `正在扫描 ${agent.name}…`;
      }
      results.push(await collectAgent(service, store, agent));
      await yieldEventLoop();
    }
    return results;
  } finally {
    if (progress) {
      progress.running = false;
      progress.phase = "idle";
      progress.currentAgent = "";
      progress.message = "";
    }
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
