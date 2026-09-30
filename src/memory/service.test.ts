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
    const item = await store.insertInbox({ title: "已拒收", body: "[REDACTED]", source: "test", scopeKind: "personal", scopeId: "", sensitivity: "secret", redacted: 1, queueStatus: "rejected", conflictIds: [], sourceKey: "" });
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

  /** B-05：同仓库两个不同文件同文时各自入队，第二个文件不得被吞。 */
  it("queues two different files with identical bodies in the same repo (B-05)", async () => {
    const { db, store, service } = await setup();
    const files = [
      { path: "C:/work/RepoA/AGENTS.md", text: "同一份仓库约定内容长文", scopeId: "RepoA" },
      { path: "C:/work/RepoA/README.md", text: "同一份仓库约定内容长文", scopeId: "RepoA" },
    ];
    const result = await service.ingestCollected("projects", files);
    expect(result.scannedFiles).toBe(2);
    expect(result.queued).toBe(2);
    expect(result.skipped).toBe(0);
    const inbox = await store.listInbox();
    expect(inbox).toHaveLength(2);
    // 各自登记指纹：重扫全部跳过
    const rescan = await service.ingestCollected("projects", files);
    expect(rescan.queued).toBe(0);
    expect(rescan.skipped).toBe(2);
    // 修改其中一个文件：只新增该文件的一个版本（旧版本行仍在队列等待审核，共 3 条）
    const changed = [{ path: files[1]!.path, text: "README 的新版本内容", scopeId: "RepoA" }];
    const bump = await service.ingestCollected("projects", changed);
    expect(bump.queued).toBe(1);
    expect(await store.listInbox()).toHaveLength(3);
    await db.close();
  });

  /** C-06：canonical source-key 保守区分五种路径形态；不得因归一化吞文件。
   *  平台显式传入以同时覆盖 Windows 与 Linux 语义（第五轮修复：Linux 绝对路径保留根斜杠、
   *  可全局；UNC 不折叠不全局；C:/ 前缀在 Linux 上只是相对路径）。 */
  it("canonical source keys classify path kinds per platform and stay conservative (C-06)", async () => {
    const { canonicalSourceKey, sourceKeyIsGlobal } = await import("./service.js");
    // Windows：盘符大小写与分隔符归一
    expect(canonicalSourceKey("C:\\Work\\Demo\\A.md", "win32")).toBe("c:/Work/Demo/A.md");
    expect(canonicalSourceKey("c:/Work/Demo/A.md", "win32")).toBe("c:/Work/Demo/A.md");
    // 消解 . / .. 片段
    expect(canonicalSourceKey("C:/Work/Demo/../Demo/./A.md", "win32")).toBe("c:/Work/Demo/A.md");
    // .. 越过根：无法证明规范形式
    expect(canonicalSourceKey("C:/../A.md", "win32")).toBeNull();
    // 大小写不折叠（保守：不吞可能不同的文件）
    expect(canonicalSourceKey("C:/Work/Demo/A.md", "win32")).not.toBe(canonicalSourceKey("C:/work/demo/a.md", "win32"));
    // 不同盘符永不相同
    expect(canonicalSourceKey("C:/x", "win32")).not.toBe(canonicalSourceKey("D:/x", "win32"));
    // 盘符相对路径（C:foo）：不全局，且与盘符绝对路径身份不同
    expect(canonicalSourceKey("C:work/A.md", "win32")).toBe("c:work/A.md");
    expect(canonicalSourceKey("C:work/A.md", "win32")).not.toBe(canonicalSourceKey("C:/work/A.md", "win32"));
    expect(sourceKeyIsGlobal("C:work/A.md", "win32")).toBe(false);
    // Windows：POSIX 绝对路径保留身份但不全局（可能来自 WSL/挂载）
    expect(canonicalSourceKey("/home/user/AGENTS.md", "win32")).toBe("/home/user/AGENTS.md");
    expect(sourceKeyIsGlobal("/home/user/AGENTS.md", "win32")).toBe(false);
    expect(canonicalSourceKey("/home/user/AGENTS.md", "win32")).not.toBe(canonicalSourceKey("home/user/AGENTS.md", "win32"));
    // Linux：POSIX 绝对路径保留根斜杠且可全局（第五轮语义回归）
    expect(canonicalSourceKey("/home/user/AGENTS.md", "linux")).toBe("/home/user/AGENTS.md");
    expect(sourceKeyIsGlobal("/home/user/AGENTS.md", "linux")).toBe(true);
    // Linux 上相对路径与绝对路径身份不同，不得互相吞并
    expect(canonicalSourceKey("home/user/AGENTS.md", "linux")).toBe("home/user/AGENTS.md");
    expect(canonicalSourceKey("home/user/AGENTS.md", "linux")).not.toBe(canonicalSourceKey("/home/user/AGENTS.md", "linux"));
    expect(sourceKeyIsGlobal("AGENTS.md", "linux")).toBe(false);
    // Linux 上 C:/ 前缀只是首段恰为 C: 的相对路径：不全局、大小写不折叠、不与 POSIX 绝对混淆
    expect(canonicalSourceKey("C:/work/AGENTS.md", "linux")).toBe("C:/work/AGENTS.md");
    expect(canonicalSourceKey("C:/work/AGENTS.md", "linux")).not.toBe(canonicalSourceKey("c:/work/AGENTS.md", "linux"));
    expect(canonicalSourceKey("C:/work/AGENTS.md", "linux")).not.toBe(canonicalSourceKey("/C:/work/AGENTS.md", "linux"));
    expect(sourceKeyIsGlobal("C:/work/AGENTS.md", "linux")).toBe(false);
    // UNC 两端都不全局，且保留 // 前缀身份（不与 POSIX 绝对路径折叠合并）
    expect(canonicalSourceKey("//server/share/AGENTS.md", "linux")).toBe("//server/share/AGENTS.md");
    expect(canonicalSourceKey("\\\\server\\share\\AGENTS.md", "win32")).toBe("//server/share/AGENTS.md");
    expect(canonicalSourceKey("//server/share/AGENTS.md", "linux")).not.toBe(canonicalSourceKey("/server/share/AGENTS.md", "linux"));
    expect(sourceKeyIsGlobal("//server/share/AGENTS.md", "linux")).toBe(false);
    expect(sourceKeyIsGlobal("//server/share/AGENTS.md", "win32")).toBe(false);
    // 3 个以上前导斜杠语义依平台而定：保守返回 null，调用方退回原值
    expect(canonicalSourceKey("///server/share/A.md", "linux")).toBeNull();
    // 反斜杠只是 Windows 分隔符（第六轮修复）：Linux 文件名可含字面反斜杠，
    // 绝对与相对形态都必须与同名正斜杠路径区分，不得折叠吞掉真实不同文件
    expect(canonicalSourceKey("/home/a\\b.md", "linux")).toBe("/home/a\\b.md");
    expect(canonicalSourceKey("/home/a\\b.md", "linux")).not.toBe(canonicalSourceKey("/home/a/b.md", "linux"));
    expect(sourceKeyIsGlobal("/home/a\\b.md", "linux")).toBe(true);
    expect(canonicalSourceKey("rel\\name.md", "linux")).toBe("rel\\name.md");
    expect(canonicalSourceKey("rel\\name.md", "linux")).not.toBe(canonicalSourceKey("rel/name.md", "linux"));
    // Windows 上反斜杠仍是分隔符，与正斜杠同键（既有语义保持）
    expect(canonicalSourceKey("C:\\Work\\A.md", "win32")).toBe(canonicalSourceKey("C:/Work/A.md", "win32"));
    expect(canonicalSourceKey("relative\\path.md", "win32")).toBe("relative/path.md");
    // 运行时默认平台冒烟（宿主为 Windows）
    expect(sourceKeyIsGlobal("C:/work/AGENTS.md")).toBe(process.platform === "win32");
    expect(sourceKeyIsGlobal("AGENTS.md")).toBe(false);
  });

  /** B-03：草稿快照在确认事务内原子复核——来源正文改变、rev 变化、直接请求 resolve、
   *  重复确认都不能提交；只有完整未变的草稿恰好写入一次。 */
  it("verifies the draft snapshot atomically before submit (B-03)", async () => {
    const { db, store, service } = await setup();
    const { sha256 } = await import("../util.js");
    const fingerprintOf = (item: { id: string; title: string; body: string }) => `${item.id}:${sha256(`${item.title}\n${item.body}`)}`;
    const queued = await service.remember({ body: "草稿来源原始内容，内容足够长", source: "cursor", actor: "collector:cursor", scopeKind: "project", scopeId: "OneLedger" });
    expect(queued.status).toBe("queued");
    const source = await store.getInbox(queued.inboxId!);
    expect(source).toBeDefined();

    const makeDraft = (expectedRev: number, id: string) => ({
      id: `dd_b03_${id}`,
      scopeKind: "project",
      scopeId: "OneLedger",
      title: "草稿标题",
      body: "草稿正文",
      sourceIds: [source!.id],
      sourceFingerprints: [fingerprintOf(source!)],
      expectedRev,
      provider: "stub",
      model: "stub",
      status: "pending" as const,
      staleReason: "",
      error: "",
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 场景 1：来源正文被改但 ID 不变 → 指纹不符，拒绝且来源保留
    const draft1 = makeDraft(0, "tamper");
    await store.upsertDraft(draft1);
    await db.run("UPDATE inbox SET body = body || '（被外部修改）' WHERE id = ?", [source!.id]);
    const tampered = await service.confirmSources({ ids: [source!.id], body: "草稿正文", title: "草稿标题", actor: "admin", expectedRev: 0, draftId: draft1.id });
    expect(tampered.status).toBe("error");
    expect(await store.listInbox()).toHaveLength(1);
    await db.run("UPDATE inbox SET body = ? WHERE id = ?", [source!.body, source!.id]);

    // 场景 2：草稿以 rev 0 生成，服务器已推进 rev 1；请求改带 expectedRev=1 也拒绝且来源不离队
    await service.remember({ body: "他人推进的 rev 1", source: "mcp:x", actor: "x", scopeKind: "project", scopeId: "OneLedger", expectedRev: 0 });
    const draft2 = makeDraft(0, "revbump");
    await store.upsertDraft(draft2);
    const stale = await service.confirmSources({ ids: [source!.id], body: "草稿正文", title: "草稿标题", actor: "admin", expectedRev: 1, draftId: draft2.id });
    expect(stale.status).toBe("error");
    expect(await store.listInbox()).toHaveLength(1);
    // 事务内复核（请求 rev 与草稿一致、但当前 rev 已越过草稿 expectedRev）→ conflict，
    // 且草稿被标记 stale（B-02：不给旧 draftId 换新 rev）
    const conflictDraft = makeDraft(0, "conflict");
    await store.upsertDraft(conflictDraft);
    const conflict = await service.confirmSources({ ids: [source!.id], body: "草稿正文", title: "草稿标题", actor: "admin", expectedRev: 0, draftId: conflictDraft.id });
    expect(conflict.status).toBe("conflict");
    expect(await store.listInbox()).toHaveLength(1);
    const marked = await store.getDraft(conflictDraft.id);
    expect(marked?.status).toBe("stale");

    // 场景 3：不过任务页直接请求 resolve——合法未过期草稿恰好提交一次
    const draft3 = makeDraft(1, "fresh");
    await store.upsertDraft(draft3);
    const done = await service.confirmSources({ ids: [source!.id], body: "草稿正文", title: "草稿标题", actor: "admin", expectedRev: 1, draftId: draft3.id });
    expect(done.status).toBe("stored");
    expect(await store.listInbox()).toHaveLength(0);
    expect((await store.getDraft(draft3.id))?.status).toBe("applied");

    // 场景 4：同一草稿第二次确认——已 applied，拒绝，不再覆盖
    const replay = await service.confirmSources({ ids: [source!.id], body: "草稿正文", title: "草稿标题", actor: "admin", expectedRev: 1, draftId: draft3.id });
    expect(replay.status).toBe("error");
    await db.close();
  });

  /** C-05：人工确认批量上限——101 条零写入拒绝，100 条边界成功。 */
  it("enforces a manual resolve batch limit (C-05)", async () => {
    const { db, store, service } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const item = await store.insertInbox({
        title: `批量材料 ${index}`,
        body: `批量验收材料 ${index}：内容足够长以通过最短限制要求。`,
        source: "cursor",
        scopeKind: "project",
        scopeId: "OneLedger",
        sensitivity: "public",
        redacted: 0,
        queueStatus: "proposed",
        conflictIds: [],
        createdAt: new Date(Date.now() + index).toISOString(),
        sourceKey: "",
      });
      ids.push(item.id);
    }
    const over = await service.confirmSources({ ids, body: "超限的整篇", actor: "admin", expectedRev: 0 });
    expect(over.status).toBe("error");
    expect(over.error ?? "").toContain("100");
    expect(await store.listInbox()).toHaveLength(101);
    expect(await store.listActive()).toHaveLength(0);
    // 边界值 100 条成功
    const done = await service.confirmSources({ ids: ids.slice(0, 100), body: "边界整篇", actor: "admin", expectedRev: 0 });
    expect(done.status).toBe("stored");
    expect(await store.listInbox()).toHaveLength(1);
    await db.close();
  }, 30_000);

  /** 第五轮修复：确认事务内对每条 fresh 来源的标题与正文二次安全扫描——
   *  sensitivity 标记可能过期或被篡改（legacy/导入/被直接改库的 public 行），
   *  内容自身必须通过扫描；任一命中整批拒绝、零写入（正式记忆/全部来源/审计不变）。 */
  it("re-scans every fresh source title and body in the confirm transaction and rejects unsafe content", async () => {
    const { db, store, service } = await setup();
    const clean = await store.insertInbox({ title: "干净采集材料", body: "正常的仓库约定说明，内容足够长。", source: "cursor", scopeKind: "project", scopeId: "OneLedger", sensitivity: "public", redacted: 0, queueStatus: "proposed", conflictIds: [], sourceKey: "" });
    const tampered = await store.insertInbox({ title: "看似公开的合成材料", body: "说明\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC-UNSAFE-MATERIAL-ONLY-FOR-TEST\n-----END PRIVATE KEY-----\n结尾", source: "cursor", scopeKind: "project", scopeId: "OneLedger", sensitivity: "public", redacted: 0, queueStatus: "proposed", conflictIds: [], sourceKey: "" });
    const result = await service.confirmSources({ ids: [clean.id, tampered.id], body: "管理台干净整篇", actor: "admin", expectedRev: 0 });
    expect(result.status).toBe("rejected");
    expect(result.hits?.some((hit) => hit.type === "private_key")).toBe(true);
    expect(result.error ?? "").toContain("安全复核");
    // 零写入：全部来源保留、无正式记忆、无 resolve 审计
    expect(await store.listInbox()).toHaveLength(2);
    expect(await store.listActive()).toHaveLength(0);
    const audits = await db.all<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('memory.resolve', 'memory.store')");
    expect(audits).toHaveLength(0);

    // PII 哨兵同样整批拒绝
    const pii = await store.insertInbox({ title: "含联系方式的合成材料", body: "联系人 admin@example.com 的仓库说明，内容足够长。", source: "cursor", scopeKind: "project", scopeId: "OneLedger", sensitivity: "public", redacted: 0, queueStatus: "proposed", conflictIds: [], sourceKey: "" });
    const piiResult = await service.confirmSources({ ids: [pii.id], body: "另一篇干净整篇", actor: "admin", expectedRev: 0 });
    expect(piiResult.status).toBe("rejected");
    expect(piiResult.hits?.some((hit) => hit.type === "email")).toBe(true);
    expect(await store.getInbox(pii.id)).toBeDefined();

    // legacy / 备份导入路径的干净行（source_key 为空、sensitivity internal）不受影响，可正常确认
    const legacy = await store.insertInbox({ title: "legacy 导入行", body: "旧版本导入的干净材料，内容足够长。", source: "legacy-import", scopeKind: "project", scopeId: "OneLedger", sensitivity: "internal", redacted: 0, queueStatus: "proposed", conflictIds: [], sourceKey: "" });
    const ok = await service.confirmSources({ ids: [clean.id, legacy.id], body: "重新整理的整篇项目记忆", actor: "admin", expectedRev: 0 });
    expect(ok.status).toBe("stored");
    // 被拒的 tampered 行仍在队列原状
    const remaining = await store.getInbox(tampered.id);
    expect(remaining?.queueStatus).toBe("proposed");
    await db.close();
  });

  /** 第六轮修复回归：security.scanEnabled=false 时确认事务内的来源安全二次复核
   *  仍必须执行——扫描开关只省掉入队替换劳动，不能让合成私钥来源绕过确认门。
   *  覆盖 true/false 开关、title/body 两个字段、混合安全/不安全来源，全事务零写入。 */
  it("rescans unsafe source titles and bodies in the confirm transaction even with scanning disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-"));
    dirs.push(dir);
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "test.db");
    config.distill.provider = "none";
    config.security.scanEnabled = false;
    const db = await openDb(config);
    const store = new Store(db);
    const service = new MemoryService(store, config);

    const unsafeBody = await store.insertInbox({ title: "正文不安全", body: "说明\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC-UNSAFE-MATERIAL-ONLY-FOR-TEST\n-----END PRIVATE KEY-----\n结尾", source: "cursor", scopeKind: "project", scopeId: "OneLedger", sensitivity: "public", redacted: 0, queueStatus: "proposed", conflictIds: [], sourceKey: "" });
    const unsafeTitle = await store.insertInbox({ title: "标题含私钥\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC-UNSAFE-TITLE-ONLY-FOR-TEST\n-----END PRIVATE KEY-----", body: "正文本身干净且足够长。", source: "cursor", scopeKind: "project", scopeId: "OneLedger", sensitivity: "public", redacted: 0, queueStatus: "proposed", conflictIds: [], sourceKey: "" });
    const clean = await store.insertInbox({ title: "干净采集材料", body: "正常的仓库约定说明，内容足够长。", source: "cursor", scopeKind: "project", scopeId: "OneLedger", sensitivity: "public", redacted: 0, queueStatus: "proposed", conflictIds: [], sourceKey: "" });

    for (const [label, ids] of [["body", [clean.id, unsafeBody.id]], ["title", [clean.id, unsafeTitle.id]], ["mixed", [unsafeBody.id]]] as const) {
      const result = await service.confirmSources({ ids: [...ids], body: "管理台干净整篇", actor: "admin", expectedRev: 0 });
      expect(result.status, label).toBe("rejected");
      expect(result.error ?? "", label).toContain("安全复核");
    }
    // 全事务零写入：全部来源保留、无正式记忆、无 resolve 审计
    expect(await store.listInbox()).toHaveLength(3);
    expect(await store.listActive()).toHaveLength(0);
    const audits = await db.all<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('memory.resolve', 'memory.store')");
    expect(audits).toHaveLength(0);

    // 同一开关下干净来源仍可正常确认（不是一刀切拒绝）
    const ok = await service.confirmSources({ ids: [clean.id], body: "扫描关闭下的干净整篇", actor: "admin", expectedRev: 0 });
    expect(ok.status).toBe("stored");
    await db.close();
  });
});
