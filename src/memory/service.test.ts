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
      source: "mcp:test",
      actor: "test",
    });
    expect(saved.memoryId).toBeTruthy();
    const hits = await service.search("worker branches", "test");
    expect(hits.some((item) => item.body.includes("check"))).toBe(true);
    await db.close();
  });

  it("overwrites the same-scope distilled document instead of appending", async () => {
    const { db, store, service } = await setup();
    const first = await service.remember({
      body: "First draft of the distilled ledger.\nKeep the gold palette.",
      source: "mcp:cursor",
      actor: "agent",
    });
    const second = await service.remember({
      body: "Final distilled ledger.\nUse gold on ink. Never append raw transcripts.",
      source: "mcp:cursor",
      actor: "agent",
    });
    expect(second.memoryId).toBe(first.memoryId);
    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.body).toContain("Never append");
    expect(active[0]?.rev).toBe(2);
    await db.close();
  });

  it("writes agent-distilled MCP notes into the official ledger", async () => {
    const { db, service } = await setup();
    const saved = await service.remember({
      body: "Prefer a gold ledger palette in OneLedger UI.",
      source: "mcp:cursor",
      actor: "test",
    });
    expect(saved.queued).toBe(false);
    expect(saved.memoryId).toBeTruthy();
    const hits = await service.search("gold ledger", "test");
    expect(hits.some((item) => item.body.includes("palette"))).toBe(true);
    await db.close();
  });

  it("queues collector dumps instead of promoting them", async () => {
    const { db, store, service } = await setup();
    const saved = await service.remember({
      body: "Raw agent transcript about a gold ledger palette in OneLedger UI.",
      source: "cursor",
      actor: "collector:cursor",
    });
    expect(saved.queued).toBe(true);
    expect(saved.memoryId).toBeUndefined();
    expect((await store.listInbox())[0]?.title).toContain("gold");
    await db.close();
  });

  it("retires collector fragments from the official ledger", async () => {
    const { db, store, service } = await setup();
    await service.remember({
      body: "Raw MEMORY.md dump that should not stay official.",
      source: "claude",
      actor: "collector:claude",
      promote: true,
      scopeKind: "project",
      scopeId: "E:/old",
    });
    expect(await store.listActive()).toHaveLength(1);
    expect(await service.retireNonDistilled()).toBe(1);
    expect(await store.listActive()).toHaveLength(0);
    expect(await service.list()).toHaveLength(0);
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
