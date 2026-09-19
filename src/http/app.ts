import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { APP_VERSION, PROTOCOL_VERSION, type AppConfig, type MemoryRecord } from "../types.js";
import { loadConfig, publicConfig, saveConfig } from "../config.js";
import { homeDir } from "../paths.js";
import { hashToken, safeEqual } from "../util.js";
import type { MemoryService } from "../memory/service.js";
import type { Store } from "../memory/store.js";
import { runCollectors } from "../collect/runner.js";
import { authorizeNode, syncWithRemote } from "../sync/engine.js";
import { allowedTools, callTool, toolSchemas } from "../mcp/tools.js";

export interface AppContext {
  config: AppConfig;
  store: Store;
  service: MemoryService;
  reload: () => Promise<void>;
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
    const counts = await ctx.store.counts();
    return c.json({
      version: APP_VERSION,
      role: ctx.config.sync.role,
      storage: ctx.config.storage.driver,
      bind: `${ctx.config.bind}:${ctx.config.port}`,
      counts,
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
    saveConfig(next);
    await ctx.reload();
    return c.json({ ok: true, config: publicConfig(ctx.config) });
  });

  app.get("/api/memories", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ memories: await ctx.service.list() });
  });

  app.get("/api/inbox", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ inbox: await ctx.store.listInbox() });
  });

  app.get("/api/audit", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ audit: await ctx.store.listAudit(), redactions: await ctx.store.listRedactions() });
  });

  app.post("/api/collect", async (c) => {
    if (!adminOk(c, ctx.config)) return c.json({ error: "unauthorized" }, 401);
    const results = await runCollectors(ctx.service, ctx.config);
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
    let applied = 0;
    for (const memory of body.memories ?? []) {
      if (memory.sensitivity === "secret") continue;
      const current = await ctx.store.getMemory(memory.id);
      if (current && current.rev >= memory.rev) continue;
      await ctx.store.upsertMemory(memory);
      applied += 1;
    }
    return c.json({ applied });
  });

  app.post("/mcp", async (c) => {
    const token = bearer(c.req.header("authorization"));
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const key = await ctx.store.findKeyByHash(hashToken(token));
    if (!key) return c.json({ error: "unauthorized" }, 401);
    await ctx.store.touchKey(key.id);
    const rpc = (await c.req.json()) as {
      jsonrpc?: string;
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const id = rpc.id ?? 1;
    if (rpc.method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "oneledger", version: APP_VERSION },
        },
      });
    }
    if (rpc.method === "tools/list") {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: Object.entries(toolSchemas).map(([name, spec]) => ({
            name,
            description: spec.description,
            inputSchema: spec.jsonSchema,
          })),
        },
      });
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name ?? "";
      if (!allowedTools(key.tools).has(name)) {
        return c.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: "tool not permitted for this key" },
        });
      }
      try {
        const result = await callTool(ctx.service, name, rpc.params?.arguments ?? {}, key.name);
        return c.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        });
      } catch (error) {
        return c.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    if (rpc.method?.startsWith("notifications/")) {
      return c.body(null, 204);
    }
    return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
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
