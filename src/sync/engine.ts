import type { AppConfig } from "../types.js";
import { PROTOCOL_VERSION } from "../types.js";
import type { Store } from "../memory/store.js";
import { nowIso } from "../util.js";
import { applyRemoteMemories } from "./apply.js";

export interface SyncReport {
  pulled: number;
  pushed: number;
  skipped: boolean;
  error?: string;
}

function headers(config: AppConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.sync.nodeKey}`,
    "x-oneledger-protocol": String(PROTOCOL_VERSION),
  };
}

export async function syncWithRemote(store: Store, config: AppConfig): Promise<SyncReport> {
  if (config.sync.role !== "leaf" || !config.sync.remoteUrl.trim()) {
    return { pulled: 0, pushed: 0, skipped: true };
  }
  const base = config.sync.remoteUrl.replace(/\/$/, "");
  const since = await store.getSyncCursor();
  try {
    const pullRes = await fetch(`${base}/api/sync/pull?since=${encodeURIComponent(since)}`, {
      headers: headers(config),
    });
    if (!pullRes.ok) {
      return { pulled: 0, pushed: 0, skipped: false, error: `pull ${pullRes.status}` };
    }
    const pulled = (await pullRes.json()) as { memories: Parameters<typeof applyRemoteMemories>[1] };
    const applied = await applyRemoteMemories(store, pulled.memories ?? []);

    const outgoing = (await store.changedSince(since)).filter((item) => item.sensitivity !== "secret");
    const pushRes = await fetch(`${base}/api/sync/push`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ memories: outgoing }),
    });
    if (!pushRes.ok) {
      return { pulled: applied, pushed: 0, skipped: false, error: `push ${pushRes.status}` };
    }
    await store.setSyncCursor(nowIso());
    return { pulled: applied, pushed: outgoing.length, skipped: false };
  } catch (error) {
    return {
      pulled: 0,
      pushed: 0,
      skipped: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function authorizeNode(config: AppConfig, header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice(7) === config.sync.nodeKey;
}
