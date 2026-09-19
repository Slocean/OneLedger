import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { openDb } from "../db/driver.js";
import { MemoryService } from "../memory/service.js";
import { Store } from "../memory/store.js";
import { collectAgent, ensureAgents } from "./runner.js";

describe("agent registry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("seeds builtin agents and can collect a custom root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ol-agents-"));
    dirs.push(dir);
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "db.sqlite");
    const db = await openDb(config);
    const store = new Store(db);
    const service = new MemoryService(store, config);
    await ensureAgents(store, config);
    const names = (await store.listAgents()).map((item) => item.id);
    expect(names).toEqual(
      expect.arrayContaining(["cursor", "claude", "codex", "continue", "zcode", "workbuddy", "qoder", "projects"]),
    );

    const root = join(dir, "notes");
    mkdirSync(root);
    writeFileSync(join(root, "memory.md"), "Prefer running check before merge.");
    await store.upsertAgent({
      id: "custom_test",
      name: "测试目录",
      kind: "custom",
      builtin: false,
      enabled: true,
      rootPath: root,
      lastScannedAt: null,
      lastScannedFiles: 0,
      lastIngested: 0,
      lastQueued: 0,
      lastRedacted: 0,
      lastError: "",
      createdAt: new Date().toISOString(),
    });
    const result = await collectAgent(service, store, (await store.getAgent("custom_test"))!);
    expect(result.scannedFiles).toBe(1);
    const updated = await store.getAgent("custom_test");
    expect(updated?.lastScannedFiles).toBe(1);
    await db.close();
  });
});
