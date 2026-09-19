import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { openDb } from "../db/driver.js";
import { MemoryService } from "./service.js";
import { Store } from "./store.js";

describe("MemoryService", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-"));
    dirs.push(dir);
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "test.db");
    config.distill.provider = "none";
    const db = await openDb(config);
    const store = new Store(db);
    const service = new MemoryService(store, config);
    return { db, store, service };
  }

  it("promotes a clean note when asked and searches it back", async () => {
    const { db, service } = await setup();
    const saved = await service.remember({
      body: "Always run check before merging worker branches.",
      source: "test",
      actor: "test",
      promote: true,
    });
    expect(saved.memoryId).toBeTruthy();
    const hits = await service.search("worker branches", "test");
    expect(hits.some((item) => item.body.includes("check"))).toBe(true);
    await db.close();
  });

  it("queues global notes that are not project conventions", async () => {
    const { db, store, service } = await setup();
    const saved = await service.remember({
      body: "Prefer a gold ledger palette in OneLedger UI.",
      source: "mcp:cursor",
      actor: "test",
    });
    expect(saved.queued).toBe(true);
    expect(saved.memoryId).toBeUndefined();
    expect((await store.listInbox())[0]?.title).toContain("gold");
    await db.close();
  });

  it("does not make secret text searchable", async () => {
    const { db, store, service } = await setup();
    const saved = await service.remember({
      body: "token sk-abcdefghijklmnopqrstuvwxyz123456 should never leak",
      source: "test",
      actor: "test",
    });
    expect(saved.redacted).toBe(true);
    expect(saved.memoryId).toBeUndefined();
    const hits = await service.search("never leak", "test");
    expect(hits).toEqual([]);
    const inbox = await store.listInbox(50, "rejected");
    expect(inbox[0]?.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    await db.close();
  });
});
