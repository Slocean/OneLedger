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
      expectedRev: 1,
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

  it("keeps the promoted fragment when nothing triggers an automatic retire", async () => {
    const { db, store, service } = await setup();
    await service.remember({
      body: "Raw MEMORY.md dump that should stay untouched by reads.",
      source: "claude",
      actor: "collector:claude",
      promote: true,
      scopeKind: "project",
      scopeId: "E:/old",
    });
    expect(await store.listActive()).toHaveLength(1);
    await service.search("MEMORY.md", "test");
    await service.list();
    await service.get("test", {});
    // 读取不再隐式清理旧碎片
    expect(await store.listActive()).toHaveLength(1);
    // 管理员仍可显式维护
    expect(await service.retireNonDistilled()).toBe(1);
    expect(await store.listActive()).toHaveLength(0);
    await db.close();
  });

  it("stores a fully redacted credential without recalling the credential", async () => {
    const { db, store, service } = await setup();
    const saved = await service.remember({
      body: "token sk-abcdefghijklmnopqrstuvwxyz123456 should never leak",
      source: "test",
      actor: "test",
    });
    expect(saved.redacted).toBe(true);
    expect(saved.memoryId).toBeUndefined();
    expect(saved.status).toBe("queued");
    const hits = await service.search("never leak", "test");
    expect(hits).toEqual([]);
    const inbox = await store.listInbox(50, "proposed");
    expect(inbox[0]?.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(inbox[0]?.body).toContain("[REDACTED:openai_key]");
    await db.close();
  });

  it("redacts credentials in titles before the title can be listed", async () => {
    const { db, service } = await setup();
    const saved = await service.remember({ body: "正常的项目说明", title: "凭据 sk-abcdefghijklmnopqrstuvwxyz123456", source: "mcp:test", actor: "test", scopeKind: "project", scopeId: "OneLedger" });
    expect(saved.status).toBe("stored");
    const listed = await service.listForAgent(10, { scopeKind: "project", scopeId: "OneLedger" });
    expect(listed[0]?.title).toContain("[REDACTED:openai_key]");
    expect(listed[0]?.title).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    await db.close();
  });

  it("keeps a stale distilled draft from replacing a newer revision", async () => {
    const { db, service } = await setup();
    const first = await service.remember({ body: "初始项目说明和测试流程", source: "mcp:a", actor: "a", scopeKind: "project", scopeId: "OneLedger", expectedRev: 0 });
    expect(first.status).toBe("stored");
    const stale = await service.remember({ body: "另一份旧稿", source: "mcp:b", actor: "b", scopeKind: "project", scopeId: "OneLedger", expectedRev: 0 });
    expect(stale.status).toBe("conflict");
    expect(stale.currentRev).toBe(1);
    const current = await service.get("test", { scopeKind: "project", scopeId: "OneLedger" });
    expect(current[0]?.body).toContain("初始项目说明");
    await db.close();
  });

  it("does not enqueue unchanged collector material again", async () => {
    const { db, store, service } = await setup();
    const input = { body: "同一份 WorkBuddy 摘要应只采集一次", source: "workbuddy", actor: "collector:workbuddy", scopeKind: "project" as const, scopeId: "OneLedger" };
    expect((await service.remember(input)).status).toBe("queued");
    expect((await service.remember(input)).status).toBe("unchanged");
    expect(await store.listInbox()).toHaveLength(1);
    await db.close();
  });

  it("archives old redaction counts before pruning rejected material", async () => {
    const { db, store } = await setup();
    const item = await store.insertInbox({ title: "已拒收", body: "[REDACTED]", source: "test", scopeKind: "personal", scopeId: "", sensitivity: "secret", redacted: 1, queueStatus: "rejected", conflictIds: [] });
    await store.addRedaction("test", "high_entropy", item.id);
    await db.run("UPDATE inbox SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", item.id]);
    await db.run("UPDATE redaction_events SET at = ? WHERE inbox_id = ?", ["2020-01-01T00:00:00.000Z", item.id]);
    await store.pruneHistory();
    expect(await store.listInbox(10, "rejected")).toHaveLength(0);
    const archive = await db.get<{ count: number }>("SELECT count FROM redaction_archive WHERE day = ? AND hit_type = ?", ["2020-01-01", "high_entropy"]);
    expect(archive?.count).toBe(1);
    await db.close();
  });

  it("keeps the inbox item when promotion fails", async () => {
    const { db, store, service } = await setup();
    const queued = await service.remember({ body: "写入失败时必须保留原材料", source: "cursor", actor: "collector:cursor", scopeKind: "project", scopeId: "OneLedger" });
    expect(queued.status).toBe("queued");
    await db.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'failure'); END");
    await expect(service.promoteInbox(queued.inboxId, "test", 0)).rejects.toThrow();
    expect(await store.listInbox()).toHaveLength(1);
    expect(await store.listActive()).toHaveLength(0);
    await db.exec("DROP TRIGGER fail_memory");
    const recovered = await service.promoteInbox(queued.inboxId, "test", 0);
    expect(recovered?.rev).toBe(1);
    expect(await store.listInbox()).toHaveLength(0);
    await db.close();
  });

  it("confirms selected sources atomically and rolls back on failure", async () => {
    const { db, store, service } = await setup();
    const first = await service.remember({ body: "第一条采集材料需要蒸馏", source: "cursor", actor: "collector:cursor", scopeKind: "project", scopeId: "OneLedger" });
    const second = await service.remember({ body: "第二条采集材料等待确认", source: "cursor", actor: "collector:cursor", scopeKind: "project", scopeId: "OneLedger" });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    await db.exec("CREATE TRIGGER fail_inbox_delete BEFORE DELETE ON inbox BEGIN SELECT RAISE(ABORT, 'failure'); END");
    const failed = await service.confirmSources({ ids: [first.inboxId, second.inboxId], body: "蒸馏后的整篇项目记忆", actor: "admin", expectedRev: 0 });
    expect(failed.status).toBe("error");
    expect(await store.listInbox()).toHaveLength(2);
    expect(await store.listActive()).toHaveLength(0);
    await db.exec("DROP TRIGGER fail_inbox_delete");
    const done = await service.confirmSources({ ids: [first.inboxId, second.inboxId], body: "蒸馏后的整篇项目记忆", actor: "admin", expectedRev: 0 });
    expect(done.status).toBe("stored");
    expect(done.rev).toBe(1);
    expect(await store.listInbox()).toHaveLength(0);
    const active = await store.listActiveByScope("project", "OneLedger");
    expect(active[0]?.body).toBe("蒸馏后的整篇项目记忆");
    // 重复提交同一来源不会覆盖更新版本
    const advanced = await service.remember({ body: "第二版蒸馏", source: "mcp:agent", actor: "agent", scopeKind: "project", scopeId: "OneLedger", expectedRev: 1 });
    expect(advanced.status).toBe("stored");
    const replay = await service.confirmSources({ ids: [first.inboxId], body: "蒸馏后的整篇项目记忆", actor: "admin", expectedRev: 0 });
    expect(replay.status).toBe("error");
    const current = await store.listActiveByScope("project", "OneLedger");
    expect(current[0]?.body).toBe("第二版蒸馏");
    expect(current[0]?.rev).toBe(2);
    await db.close();
  });

  it("confirm sources returns a conflict when the scope moved on", async () => {
    const { db, store, service } = await setup();
    const first = await service.remember({ body: "已有项目记忆", source: "mcp:a", actor: "a", scopeKind: "project", scopeId: "OneLedger", expectedRev: 0 });
    expect(first.status).toBe("stored");
    const queued = await service.remember({ body: "新的采集材料", source: "cursor", actor: "collector:cursor", scopeKind: "project", scopeId: "OneLedger" });
    const conflict = await service.confirmSources({ ids: [queued.inboxId], body: "管理台编辑的整篇", actor: "admin", expectedRev: 0 });
    expect(conflict.status).toBe("conflict");
    expect(conflict.currentRev).toBe(1);
    expect(await store.listInbox()).toHaveLength(1);
    const active = await store.listActiveByScope("project", "OneLedger");
    expect(active[0]?.body).toBe("已有项目记忆");
    await db.close();
  });

  it("collect fingerprints survive the inbox lifecycle", async () => {
    const { db, store, service } = await setup();
    const files = [{ path: "C:/work/OneLedger/AGENTS.md", text: "项目约定内容版本一", scopeId: "OneLedger" }];
    const first = await service.ingestCollected("projects", files);
    expect(first.queued).toBe(1);
    const second = await service.ingestCollected("projects", files);
    expect(second.queued).toBe(0);
    expect(second.skipped).toBe(1);
    const inbox = await store.listInbox();
    const confirmed = await service.confirmSources({ ids: [inbox[0]!.id], body: "蒸馏整篇", actor: "admin", expectedRev: 0 });
    expect(confirmed.status).toBe("stored");
    const third = await service.ingestCollected("projects", files);
    expect(third.queued).toBe(0);
    expect(third.skipped).toBe(1);
    expect(await store.listInbox()).toHaveLength(0);
    const changed = [{ path: files[0]!.path, text: "项目约定内容版本二", scopeId: "OneLedger" }];
    const fourth = await service.ingestCollected("projects", changed);
    expect(fourth.queued).toBe(1);
    expect(await store.listInbox()).toHaveLength(1);
    await db.close();
  });

  it("lists and searches memories by project scopeId", async () => {
    const { db, service } = await setup();
    await service.remember({
      body: "CofoeAirLink uses port 3001 for the Vite app.",
      source: "mcp:test",
      actor: "test",
      scopeKind: "project",
      scopeId: "CofoeAirLink_Web",
    });
    await service.remember({
      body: "RollTheWarTable keeps domain worktrees under RWT-ai.",
      source: "mcp:test",
      actor: "test",
      scopeKind: "project",
      scopeId: "RollTheWarTable",
    });
    const listed = await service.list(20, { scopeKind: "project", scopeId: "CofoeAirLink_Web" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.scopeId).toBe("CofoeAirLink_Web");
    const hits = await service.search("worktrees", "test", 8, { scopeId: "RollTheWarTable" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scopeId).toBe("RollTheWarTable");
    const got = await service.get("test", { scopeKind: "project", scopeId: "CofoeAirLink_Web" });
    expect(got).toHaveLength(1);
    expect(got[0]?.body).toContain("port 3001");
    const byId = await service.get("test", { id: hits[0]?.id });
    expect(byId[0]?.scopeId).toBe("RollTheWarTable");
    await db.close();
  });

  it("finds a Chinese phrase inside a longer memory through the FTS index", async () => {
    const { db, service } = await setup();
    await service.remember({ body: "采集器只读取约定文件，蒸馏后形成连贯的项目记忆。", source: "mcp:test", actor: "test", scopeKind: "project", scopeId: "OneLedger" });
    const hits = await service.search("约定文件", "test", 8, { scopeId: "OneLedger" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.body).toContain("约定文件");
    await db.close();
  });
});
