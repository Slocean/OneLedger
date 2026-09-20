import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { APP_VERSION, DATA_SCHEMA_VERSION, PROTOCOL_VERSION, type AppConfig, type MemoryRecord } from "../types.js";
import { loadConfig, publicConfig, saveConfig } from "../config.js";
import { homeDir } from "../paths.js";
import { hashToken, newId, nowIso, safeEqual } from "../util.js";
import type { MemoryService } from "../memory/service.js";
import type { Store } from "../memory/store.js";
import { collectAgent, ensureAgents, runCollectorsWithProgress } from "../collect/runner.js";
import { pathExists } from "../collect/catalog.js";
import { snapshotCollect, type CollectProgress } from "../collect/progress.js";
import { applyRemoteMemories } from "../sync/apply.js";
import { authorizeNode, syncWithRemote } from "../sync/engine.js";
import { allowedTools, createMcpServer } from "../mcp/create.js";
import { checkForUpdate } from "../update.js";

export interface AppContext {
  config: AppConfig;
  store: Store;
  service: MemoryService;
  reload: () => Promise<void>;
  collectProgress: CollectProgress;
  collectJob?: Promise<unknown>;
}

export function startCollect(ctx: AppContext): Promise<unknown> {
  if (ctx.collectJob) return ctx.collectJob;
  const progress = ctx.collectProgress;
  progress.running = true;
  progress.phase = "scanning";
  if (!progress.message) progress.message = "正在扫描本地记忆…";
  ctx.collectJob = runCollectorsWithProgress(ctx.service, ctx.store, ctx.config, progress)
    .catch((error) => {
      console.error("collect failed", error);
    })
    .finally(() => {
      ctx.collectJob = undefined;
    });
  return ctx.collectJob;
}

export function startCollectIfPending(ctx: AppContext): void {
  if (ctx.collectProgress.phase !== "pending") return;
  void startCollect(ctx);
}

function adminOk(c: { req: { header: (name: string) => string | undefined } }, config: AppConfig): boolean {
  const token = c.req.header("x-admin-token") || bearer(c.req.header("authorization"));
  return Boolean(token && safeEqual(token, config.adminToken));
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.use("/api/*", cors());
  app.use("/mcp", cors());

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      name: "oneledger",
      version: APP_VERSION,
      protocol: PROTOCOL_VERSION,
      home: homeDir(),
    }),
  );

  app.get("/api/status", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    startCollectIfPending(ctx);
    const counts = await ctx.store.counts();
    const collect = snapshotCollect(ctx.collectProgress);
    return c.json({
      version: APP_VERSION,
      role: ctx.config.sync.role,
      storage: ctx.config.storage.driver,
      bind: `${ctx.config.bind}:${ctx.config.port}`,
      counts,
      collecting: collect.running,
      collect,
    });
  });

  app.get("/api/config", (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json(publicConfig(ctx.config));
  });

  app.put("/api/config", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const patch = (await c.req.json()) as Partial<AppConfig>;
    const next = loadConfig();
    if (patch.bind) next.bind = patch.bind;
    if (patch.port) next.port = Number(patch.port);
    if (patch.storage) {
      next.storage = { ...next.storage, ...patch.storage };
      if (patch.storage.postgresUrl === undefined) next.storage.postgresUrl = next.storage.postgresUrl;
      if (typeof patch.storage.postgresUrl === "string" && patch.storage.postgresUrl.includes("****")) {
        next.storage.postgresUrl = ctx.config.storage.postgresUrl;
      }
    }
    if (patch.sync) {
      next.sync = { ...next.sync, ...patch.sync };
      if (patch.sync.nodeKey === "•••• set") next.sync.nodeKey = ctx.config.sync.nodeKey;
    }
    if (patch.collect) next.collect = { ...next.collect, ...patch.collect };
    if (patch.distill) {
      next.distill = { ...next.distill, ...patch.distill };
      if (patch.distill.apiKey === "•••• set") next.distill.apiKey = ctx.config.distill.apiKey;
    }
    if (patch.security) next.security = { ...next.security, ...patch.security };
    if (typeof patch.updateUrl === "string") next.updateUrl = patch.updateUrl;
    saveConfig(next);
    await ctx.reload();
    return c.json({ ok: true, config: publicConfig(ctx.config) });
  });

  app.get("/api/memories", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ memories: await ctx.service.list() });
  });

  app.get("/api/memories/export", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const memories = await ctx.service.list(10_000);
    return c.json({
      name: "oneledger",
      version: APP_VERSION,
      exportedAt: nowIso(),
      count: memories.length,
      memories,
    });
  });

  app.post("/api/remember", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json()) as {
      body?: string;
      title?: string;
      scopeKind?: "global" | "project" | "personal";
      scopeId?: string;
    };
    if (!body.body?.trim()) return c.json({ error: "body required" }, 400);
    const result = await ctx.service.remember({
      body: body.body,
      title: body.title,
      scopeKind: body.scopeKind,
      scopeId: body.scopeId,
      source: "ui",
      actor: "admin",
    });
    return c.json(result);
  });

  app.post("/api/inbox/:id/reject", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const ok = await ctx.service.rejectInbox(c.req.param("id"), "admin");
    return c.json({ ok }, ok ? 200 : 404);
  });

  app.get("/api/version", (c) =>
    c.json({
      version: APP_VERSION,
      protocol: PROTOCOL_VERSION,
      dataSchema: DATA_SCHEMA_VERSION,
    }),
  );

  app.get("/api/updates", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json(await checkForUpdate(ctx.config.updateUrl));
  });

  app.post("/api/updates/download", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json(
      {
        ok: false,
        error: "热更新只用于打包后的桌面版。当前是服务模式，请到 Releases 下载安装包或便携包。",
        html_url: "https://github.com/Slocean/OneLedger/releases",
      },
      400,
    );
  });

  app.post("/api/updates/apply", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ ok: false, error: "热更新只用于打包后的桌面版。" }, 400);
  });

  app.post("/api/updates/install", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json(
      {
        ok: false,
        error: "热更新只用于打包后的桌面版。当前是服务模式，请到 Releases 下载安装包或便携包。",
        html_url: "https://github.com/Slocean/OneLedger/releases",
      },
      400,
    );
  });

  app.get("/api/inbox", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ inbox: await ctx.store.listInbox() });
  });

  app.post("/api/inbox", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json()) as { body?: string; title?: string };
    if (!body.body?.trim()) return c.json({ error: "body required" }, 400);
    const result = await ctx.service.remember({
      body: body.body,
      title: body.title,
      source: "custom",
      actor: "admin",
    });
    return c.json(result);
  });

  app.get("/api/audit", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ audit: await ctx.store.listAudit(), redactions: await ctx.store.listRedactions() });
  });

  app.get("/api/agents", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    await ensureAgents(ctx.store, ctx.config);
    const agents = (await ctx.store.listAgents()).map((agent) => ({
      ...agent,
      pathExists: pathExists(agent.rootPath),
    }));
    return c.json({ agents });
  });

  app.post("/api/agents", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json()) as { name?: string; rootPath?: string };
    if (!body.name?.trim() || !body.rootPath?.trim()) {
      return c.json({ error: "name and rootPath required" }, 400);
    }
    const record = {
      id: newId("ag"),
      name: body.name.trim(),
      kind: "custom" as const,
      builtin: false,
      enabled: true,
      rootPath: body.rootPath.trim(),
      lastScannedAt: null,
      lastScannedFiles: 0,
      lastIngested: 0,
      lastQueued: 0,
      lastRedacted: 0,
      lastError: "",
      createdAt: nowIso(),
    };
    await ctx.store.upsertAgent(record);
    await ctx.store.audit("admin", "agent.create", record.id);
    return c.json({ agent: { ...record, pathExists: pathExists(record.rootPath) } });
  });

  app.put("/api/agents/:id", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const current = await ctx.store.getAgent(c.req.param("id"));
    if (!current) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as { enabled?: boolean; rootPath?: string; name?: string };
    const next = {
      ...current,
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      rootPath: body.rootPath?.trim() || current.rootPath,
      name: body.name?.trim() || current.name,
    };
    await ctx.store.upsertAgent(next);
    return c.json({ agent: { ...next, pathExists: pathExists(next.rootPath) } });
  });

  app.delete("/api/agents/:id", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const current = await ctx.store.getAgent(c.req.param("id"));
    if (!current) return c.json({ error: "not found" }, 404);
    if (current.builtin) return c.json({ error: "builtin agents cannot be deleted" }, 400);
    await ctx.store.deleteAgent(current.id);
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/collect", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const current = await ctx.store.getAgent(c.req.param("id"));
    if (!current) return c.json({ error: "not found" }, 404);
    const result = await collectAgent(ctx.service, ctx.store, current);
    return c.json({ result, agent: await ctx.store.getAgent(current.id) });
  });

  app.post("/api/collect", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    if (ctx.collectProgress.phase === "scanning") {
      return c.json({ error: "collecting", collect: snapshotCollect(ctx.collectProgress) }, 409);
    }
    const results = await runCollectorsWithProgress(ctx.service, ctx.store, ctx.config, ctx.collectProgress);
    return c.json({ results });
  });

  app.post("/api/sync", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json(await syncWithRemote(ctx.store, ctx.config));
  });

  app.get("/api/keys", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const keys = await ctx.store.listKeys();
    return c.json({
      keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        tokenPrefix: key.tokenPrefix,
        tools: key.tools,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
      })),
    });
  });

  app.post("/api/keys", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json()) as { name?: string };
    const issued = await ctx.service.issueKey(body.name?.trim() || "agent");
    return c.json({ id: issued.id, name: issued.name, token: issued.token, prefix: issued.tokenPrefix });
  });

  app.get("/api/sync/pull", async (c) => {
    if (!authorizeNode(ctx.config, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    if (Number(c.req.header("x-oneledger-protocol") ?? 1) !== PROTOCOL_VERSION) {
      return c.json({ error: "protocol mismatch" }, 409);
    }
    const since = c.req.query("since") || "1970-01-01T00:00:00.000Z";
    const memories = (await ctx.store.changedSince(since)).filter((item) => item.sensitivity !== "secret");
    return c.json({ memories });
  });

  app.post("/api/sync/push", async (c) => {
    if (!authorizeNode(ctx.config, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json()) as { memories?: MemoryRecord[] };
    const applied = await applyRemoteMemories(ctx.store, body.memories ?? []);
    return c.json({ applied });
  });

  app.all("/mcp", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const key = await ctx.store.findKeyByHash(hashToken(token));
    if (!key) return c.json({ error: "unauthorized" }, 401);
    await ctx.store.touchKey(key.id);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(ctx.service, key.name, allowedTools(key.tools));
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  const webDir = findWebDir();
  if (webDir) {
    app.use("/*", serveStatic({ root: webDir }));
    app.get("/", (c) => {
      const html = readFileSync(join(webDir, "index.html"), "utf8");
      return c.html(html);
    });
  } else {
    app.get("/", (c) => c.text("OneLedger API is running. Build the UI with npm run build."));
  }

  return app;
}

function findWebDir(): string | undefined {
  const candidates = [join(process.cwd(), "dist", "web"), join(process.cwd(), "web", "dist")];
  return candidates.find((dir) => existsSync(join(dir, "index.html")));
}
