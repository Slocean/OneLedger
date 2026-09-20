import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCollectProgress, markCollectPending } from "../collect/progress.js";
import { defaultConfig } from "../config.js";
import { openDb } from "../db/driver.js";
import { MemoryService } from "../memory/service.js";
import { Store } from "../memory/store.js";
import { createApp, type AppContext } from "./app.js";

describe("status collect progress", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  async function ctxWithProgress() {
    const dir = mkdtempSync(join(tmpdir(), "ol-status-"));
    dirs.push(dir);
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "db.sqlite");
    config.collect.cursor = false;
    config.collect.claude = false;
    config.collect.codex = false;
    config.collect.continue = false;
    config.collect.zcode = false;
    config.collect.workbuddy = false;
    config.collect.qoder = false;
    config.collect.projects = false;
    const db = await openDb(config);
    const store = new Store(db);
    const service = new MemoryService(store, config);
    const collectProgress = createCollectProgress();
    markCollectPending(collectProgress);
    const ctx: AppContext = {
      config,
      store,
      service,
      reload: async () => undefined,
      collectProgress,
    };
    return { db, ctx, app: createApp(ctx) };
  }

  it("lets health through while collect is still pending", async () => {
    const { db, ctx, app } = await ctxWithProgress();
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(ctx.collectProgress.phase).toBe("pending");
    await db.close();
  });

  it("starts collect only after status, and exposes loading fields", async () => {
    const { db, ctx, app } = await ctxWithProgress();
    const status = await app.request("/api/status", {
      headers: { "x-admin-token": ctx.config.adminToken },
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      collecting: boolean;
      collect: { running: boolean; phase: string; message: string };
    };
    expect(ctx.collectProgress.phase).not.toBe("pending");
    expect(["scanning", "idle"]).toContain(body.collect.phase);
    await ctx.collectJob;
    expect(ctx.collectProgress.running).toBe(false);
    expect(ctx.collectProgress.phase).toBe("idle");
    await db.close();
  });
});
