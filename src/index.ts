#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { openDb, type Db } from "./db/driver.js";
import { Store } from "./memory/store.js";
import { MemoryService } from "./memory/service.js";
import { createApp, type AppContext } from "./http/app.js";
import { startStdioMcp } from "./mcp/stdio.js";
import { runCollectors } from "./collect/runner.js";
import { syncWithRemote } from "./sync/engine.js";
import { APP_VERSION } from "./types.js";
import { configPath, homeDir } from "./paths.js";

async function boot() {
  const config = loadConfig();
  const db = await openDb(config);
  const store = new Store(db);
  const service = new MemoryService(store, config);
  return { config, db, store, service };
}

async function ensureDefaultKey(service: MemoryService, store: Store): Promise<void> {
  const keys = await store.listKeys();
  if (keys.length > 0) return;
  const issued = await service.issueKey("default-agent");
  console.log(`Issued first MCP key (store it now): ${issued.token}`);
}

function printBanner(config: ReturnType<typeof loadConfig>): void {
  console.log(`OneLedger ${APP_VERSION}`);
  console.log(`home     ${homeDir()}`);
  console.log(`config   ${configPath()}`);
  console.log(`ui       http://${config.bind}:${config.port}/`);
  console.log(`mcp      http://${config.bind}:${config.port}/mcp`);
  console.log(`admin    token in config.json (x-admin-token)`);
}

async function serveCmd(): Promise<void> {
  let db: Db | undefined;
  const ctx: AppContext = {
    config: loadConfig(),
    store: undefined as unknown as Store,
    service: undefined as unknown as MemoryService,
    reload: async () => undefined,
  };

  const start = async () => {
    if (db) await db.close();
    const bootstrapped = await boot();
    db = bootstrapped.db;
    ctx.config = bootstrapped.config;
    ctx.store = bootstrapped.store;
    ctx.service = bootstrapped.service;
    await ensureDefaultKey(ctx.service, ctx.store);
  };

  ctx.reload = start;
  await start();
  printBanner(ctx.config);

  const timers: Timer[] = [];
  const collectMs = Math.max(ctx.config.collect.intervalMin, 5) * 60_000;
  const syncMs = Math.max(ctx.config.sync.intervalMin, 5) * 60_000;
  timers.push(
    setInterval(() => {
      void runCollectors(ctx.service, ctx.config).catch((error) => console.error("collect failed", error));
    }, collectMs),
  );
  timers.push(
    setInterval(() => {
      void syncWithRemote(ctx.store, ctx.config).catch((error) => console.error("sync failed", error));
    }, syncMs),
  );
  void runCollectors(ctx.service, ctx.config);

  serve(
    {
      fetch: (request) => createApp(ctx).fetch(request),
      hostname: ctx.config.bind,
      port: ctx.config.port,
    },
    (info) => {
      console.log(`listening on http://${info.address}:${info.port}`);
    },
  );

  const shutdown = async () => {
    for (const timer of timers) clearInterval(timer);
    if (db) await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

type Timer = ReturnType<typeof setInterval>;

async function main(): Promise<void> {
  const [cmd = "serve"] = process.argv.slice(2);
  if (cmd === "version" || cmd === "-v" || cmd === "--version") {
    console.log(APP_VERSION);
    return;
  }
  if (cmd === "mcp") {
    const { service } = await boot();
    await startStdioMcp(service);
    return;
  }
  if (cmd === "collect") {
    const { service, config, db } = await boot();
    console.log(JSON.stringify(await runCollectors(service, config), null, 2));
    await db.close();
    return;
  }
  if (cmd === "serve") {
    await serveCmd();
    return;
  }
  console.error("Usage: oneledger <serve|mcp|collect|version>");
  process.exit(1);
}

void main();
