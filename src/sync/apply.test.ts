import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { openDb } from "../db/driver.js";
import { MemoryService } from "../memory/service.js";
import { Store } from "../memory/store.js";
import { applyRemoteMemories } from "./apply.js";
import { createApp, type AppContext } from "../http/app.js";

describe("sync apply", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  async function node(name: string) {
    const dir = mkdtempSync(join(tmpdir(), `ol-${name}-`));
    dirs.push(dir);
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "db.sqlite");
    config.sync.nodeKey = "shared-node-key";
    config.sync.role = "hub";
    const db = await openDb(config);
    const store = new Store(db);
    const service = new MemoryService(store, config);
    return { db, store, service, config };
  }

  it("replicates a higher-rev memory and ignores secrets", async () => {
    const a = await node("a");
    const b = await node("b");
    const saved = await a.service.remember({
      body: "Hub and leaf share the same check command.",
      source: "project:demo",
      actor: "test",
    });
    const memory = await a.store.getMemory(saved.memoryId!);
    expect(memory).toBeTruthy();
    const applied = await applyRemoteMemories(b.store, [
      memory!,
      { ...memory!, id: "mem_secret", sensitivity: "secret", body: "password=1" },
    ]);
    expect(applied).toBe(1);
    expect(await b.store.getMemory(memory!.id)).toMatchObject({ body: memory!.body });
    expect(await b.store.getMemory("mem_secret")).toBeUndefined();
    await a.db.close();
    await b.db.close();
  });

  it("accepts hub push over the HTTP API", async () => {
    const hub = await node("hub");
    const ctx: AppContext = {
      config: hub.config,
      store: hub.store,
      service: hub.service,
      reload: async () => undefined,
    };
    const app = createApp(ctx);
    const saved = await hub.service.remember({
      body: "Sync protocol version stays at 1 until we bump it.",
      source: "project:demo",
      actor: "test",
    });
    const memory = await hub.store.getMemory(saved.memoryId!);
    const leaf = await node("leaf");
    const push = await app.request("/api/sync/push", {
      method: "POST",
      headers: {
        authorization: "Bearer shared-node-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ memories: [memory] }),
    });
    expect(push.status).toBe(200);
    const applied = await applyRemoteMemories(leaf.store, [memory!]);
    expect(applied).toBe(1);
    await hub.db.close();
    await leaf.db.close();
  });
});
