import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { openDb } from "../db/driver.js";
import { DistillJobService } from "./distillJob.js";
import { MemoryService } from "./service.js";
import { Store } from "./store.js";

describe("DistillJobService", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-distill-"));
    dirs.push(dir);
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "test.db");
    config.distill.provider = "none";
    const db = await openDb(config);
    const store = new Store(db);
    const service = new MemoryService(store, config);
    const job = new DistillJobService(store, config);
    return { db, store, service, job, config };
  }

  async function queue(service: MemoryService, body: string, scopeId = "OneLedger") {
    return service.remember({
      body,
      source: "cursor",
      actor: "collector:cursor",
      scopeKind: "project",
      scopeId,
    });
  }

  it("groups pending material into tasks and hides nothing from the operator", async () => {
    const { db, job, service } = await setup();
    await queue(service, "第一条采集材料");
    await queue(service, "第二条采集材料");
    await service.remember({ body: "WorkBuddy 摘要材料", source: "workbuddy", actor: "collector:workbuddy", scopeKind: "project", scopeId: "OneLedger" });
    const tasks = await job.tasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.scopeId).toBe("OneLedger");
    expect(tasks[0]?.pending).toBe(3);
    expect(tasks[0]?.highSignal).toBe(1);
    // 高信号来源排在首位
    expect(tasks[0]?.sources[0]?.source).toBe("workbuddy");
    expect(tasks[0]?.oldestWaitingAt).toBeTruthy();
    await db.close();
  });

  it("aggregates many scopes without one query per scope", async () => {
    const { db, job, store } = await setup();
    // 造 300 个作用域 × 3 条材料；逐作用域查询会明显变慢甚至拖死连接
    for (let index = 0; index < 300; index += 1) {
      for (let item = 0; item < 3; item += 1) {
        await store.insertInbox({
          title: `材料 ${index}-${item}`,
          body: `正文 ${index}-${item}`,
          source: index % 2 === 0 ? "workbuddy" : "cursor",
          scopeKind: "project",
          scopeId: `scope-${index}`,
          sensitivity: "public",
          redacted: 0,
          queueStatus: "proposed",
          conflictIds: [],
        });
      }
    }
    const startedAt = Date.now();
    const tasks = await job.tasks();
    const elapsed = Date.now() - startedAt;
    expect(tasks).toHaveLength(300);
    expect(tasks.every((task) => task.pending === 3)).toBe(true);
    expect(tasks.every((task) => task.sources.length === 3)).toBe(true);
    // 逐作用域查询在 900 行规模下就会远超此阈值
    expect(elapsed).toBeLessThan(20_000);
    await db.close();
  });

  it("stays usable with distill.provider=none and never auto-promotes", async () => {
    const { db, job, store, service } = await setup();
    await queue(service, "没有模型时也要能手工整理");
    const result = await job.generateDraft("project", "OneLedger", "admin");
    expect(result.status).toBe("error");
    expect(String(result.error)).toContain("手工整理");
    expect(await store.listActive()).toHaveLength(0);
    // 手工路径仍可用第 2 步的原子确认
    const inbox = await store.listInbox();
    const done = await service.confirmSources({ ids: [inbox[0]!.id], body: "手工整理的整篇", actor: "admin", expectedRev: 0 });
    expect(done.status).toBe("stored");
    await db.close();
  });

  it("keeps sources when the model call fails and records the reason", async () => {
    const { db, job, store, service, config } = await setup();
    config.distill.provider = "openai-compatible";
    config.distill.baseUrl = "http://127.0.0.1:9/never";
    config.distill.model = "test-model";
    await queue(service, "模型失败时来源不能丢");
    const result = await job.generateDraft("project", "OneLedger", "admin");
    expect(result.status).toBe("failed");
    expect(String(result.error)).toBeTruthy();
    // 来源仍在队列
    expect(await store.listInbox()).toHaveLength(1);
    const draft = await store.latestDraft("project", "OneLedger");
    expect(draft?.status).toBe("failed");
    expect(draft?.error).toBeTruthy();
    expect(draft?.attempts).toBe(1);
    await db.close();
  });

  it("generates a pending draft from a stub provider and never promotes it", async () => {
    const { db, job, store, service, config } = await setup();
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += String(chunk); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "项目约定总览\n\n这是模型整理的整篇记忆。" } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    config.distill.provider = "openai-compatible";
    config.distill.baseUrl = `http://127.0.0.1:${port}/v1`;
    config.distill.model = "stub-model";

    try {
      await queue(service, "生成草稿用的材料");
      const result = await job.generateDraft("project", "OneLedger", "admin");
      expect(result.status).toBe("pending");
      const draft = await store.latestDraft("project", "OneLedger");
      expect(draft?.status).toBe("pending");
      expect(draft?.title).toContain("项目约定总览");
      expect(draft?.body).toContain("模型整理");
      expect(draft?.expectedRev).toBe(0);
      expect(draft?.sourceIds).toHaveLength(1);
      // 未审核的草稿不得进入正式记忆
      expect(await store.listActive()).toHaveLength(0);
      expect(await service.search("模型整理", "agent")).toHaveLength(0);
      expect(await service.get("agent", { scopeKind: "project", scopeId: "OneLedger" })).toHaveLength(0);
      // 审核提交复用原子确认
      const done = await service.confirmSources({ ids: draft!.sourceIds, body: draft!.body, title: draft!.title, actor: "admin", expectedRev: draft!.expectedRev });
      expect(done.status).toBe("stored");
      expect(await store.listInbox()).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });

  it("marks a draft stale when the scope moved on, and keeps sources and draft", async () => {
    const { db, job, store, service, config } = await setup();
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "草稿标题\n\n草稿正文" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    config.distill.provider = "openai-compatible";
    config.distill.baseUrl = `http://127.0.0.1:${port}/v1`;
    config.distill.model = "stub-model";

    try {
      await queue(service, "生成草稿的材料");
      const generated = await job.generateDraft("project", "OneLedger", "admin");
      expect(generated.status).toBe("pending");
      const draft = await store.latestDraft("project", "OneLedger");
      // 另一个 Agent 推进了作用域
      const advanced = await service.remember({ body: "另一个 Agent 更新的正式记忆", source: "mcp:agent", actor: "agent", scopeKind: "project", scopeId: "OneLedger", expectedRev: 0 });
      expect(advanced.status).toBe("stored");
      const reason = await job.markStaleIfChanged(draft!);
      expect(reason).toBeTruthy();
      const after = await store.latestDraft("project", "OneLedger");
      expect(after?.status).toBe("stale");
      // 草稿与来源都保留
      expect(after?.body).toContain("草稿正文");
      expect(await store.listInbox()).toHaveLength(1);
      // 过期草稿直接提交会被原子操作拒绝
      const conflict = await service.confirmSources({ ids: draft!.sourceIds, body: draft!.body, title: draft!.title, actor: "admin", expectedRev: draft!.expectedRev });
      expect(conflict.status).toBe("conflict");
      expect(await store.listActive()).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });

  it("does not send secret-classified material to the model", async () => {
    const { db, job, store, config } = await setup();
    const { createServer } = await import("node:http");
    let received = "";
    const server = createServer((request, response) => {
      request.on("data", (chunk) => { received += String(chunk); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "标题\n\n正文" } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    config.distill.provider = "openai-compatible";
    config.distill.baseUrl = `http://127.0.0.1:${port}/v1`;
    config.distill.model = "stub-model";

    try {
      const secret = await store.insertInbox({
        title: "含秘密材料",
        body: "-----BEGIN PRIVATE KEY-----\nraw",
        source: "cursor",
        scopeKind: "project",
        scopeId: "OneLedger",
        sensitivity: "secret",
        redacted: 1,
        queueStatus: "proposed",
        conflictIds: [],
      });
      await store.insertInbox({
        title: "安全材料",
        body: "普通公开材料",
        source: "cursor",
        scopeKind: "project",
        scopeId: "OneLedger",
        sensitivity: "public",
        redacted: 0,
        queueStatus: "proposed",
        conflictIds: [],
      });
      const result = await job.generateDraft("project", "OneLedger", "admin");
      expect(result.status).toBe("pending");
      expect(result.blocked).toContain(secret.id);
      expect(received).not.toContain("BEGIN PRIVATE KEY");
      expect(received).toContain("普通公开材料");
    } finally {
      await db.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
