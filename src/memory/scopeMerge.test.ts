import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { openDb } from "../db/driver.js";
import { MemoryService } from "./service.js";
import { confirmMerge, fingerprintDamageReport, isRepositoryScopeId, listMergeOperations, previewMerge, revertMerge } from "./scopeMerge.js";
import { Store } from "./store.js";

describe("scopeMerge", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-merge-"));
    dirs.push(dir);
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "test.db");
    config.distill.provider = "none";
    const db = await openDb(config);
    const store = new Store(db);
    const service = new MemoryService(store, config);
    return { db, store, service };
  }

  async function queue(service: MemoryService, body: string, scopeId: string) {
    const result = await service.remember({ body, source: "cursor", actor: "collector:cursor", scopeKind: "project", scopeId });
    expect(result.status).toBe("queued");
    return result.inboxId;
  }

  async function fingerprintRows(store: Store) {
    return store.dbAll("SELECT id, collector, source_key, scope_kind, scope_id, rules_version, content_hash FROM collect_fingerprints ORDER BY id");
  }

  /** B-07：从预览取本批全部 ID（“全选本批”等价于 UI 逐条勾选后提交）；预览失败返回空集。 */
  async function previewBatchIds(store: Store, fromKind: string, fromId: string, toId: string): Promise<string[]> {
    const view = await previewMerge(store, fromKind, fromId, toId);
    if (view.status !== "ok") return [];
    return ((view.batchItems ?? []) as Array<{ id: string }>).map((item) => item.id);
  }

  async function confirmAll(store: Store, fromKind: string, fromId: string, toId: string, digest: string, actor: string) {
    const ids = await previewBatchIds(store, fromKind, fromId, toId);
    return confirmMerge(store, fromKind, fromId, toId, digest, ids, actor);
  }

  it("repository scope validation rejects paths", () => {
    expect(isRepositoryScopeId("OneLedger")).toBe(true);
    expect(isRepositoryScopeId("  CofoeAirLink_Web ")).toBe(true);
    expect(isRepositoryScopeId("")).toBe(false);
    expect(isRepositoryScopeId("skills\\system\\skill")).toBe(false);
    expect(isRepositoryScopeId("E:/work")).toBe(false);
    expect(isRepositoryScopeId("C:Users")).toBe(false);
    expect(isRepositoryScopeId(".")).toBe(false);
    expect(isRepositoryScopeId("..")).toBe(false);
  });

  it("preview, confirm and revert move only proposed material", async () => {
    const { db, store, service } = await setup();
    await queue(service, "路径型作用域材料一", "skills\\system\\skill");
    await queue(service, "路径型作用域材料二", "skills\\system\\skill");
    const direct = await service.remember({ body: "目标项目已有记忆", source: "mcp:a", actor: "a", scopeKind: "project", scopeId: "Target", expectedRev: 0 });
    expect(direct.status).toBe("stored");
    await queue(service, "目标项目已有材料", "Target");
    const rejectedId = await queue(service, "准备拒收的材料", "skills\\system\\skill");
    await service.rejectInbox(rejectedId, "admin");

    const view = await previewMerge(store, "project", "skills\\system\\skill", "Target");
    expect(view.status).toBe("ok");
    expect(view.pending).toBe(2);
    expect(view.batch).toBe(2);
    expect(view.remaining).toBe(0);
    expect(view.toPending).toBe(1);
    expect(view.blocked).toHaveLength(0);
    const items = view.batchItems as Array<{ id: string; title: string }>;
    expect(items).toHaveLength(2);
    const digest = String(view.digest);

    const applied = await confirmAll(store, "project", "skills\\system\\skill", "Target", digest, "admin");
    expect(applied.status).toBe("applied");
    expect(applied.moved).toBe(2);
    expect(applied.remaining).toBe(0);
    const operationId = String(applied.operationId);

    // rejected 材料留在原作用域，正式记忆不动
    const rejected = await store.dbAll("SELECT scope_id FROM inbox WHERE queue_status = 'rejected'");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.scope_id).toBe("skills\\system\\skill");
    const active = await store.listActiveByScope("project", "Target");
    expect(active).toHaveLength(1);
    expect(active[0]?.rev).toBe(1);

    // 批次精确 ID 落在 item 表，moved_ids 不再塞大列表
    const opItems = await store.dbAll("SELECT inbox_id FROM scope_merge_operation_items WHERE operation_id = ?", [operationId]);
    expect(opItems).toHaveLength(2);
    const opRow = await store.dbGet<{ moved_ids: string }>("SELECT moved_ids FROM scope_merge_operations WHERE id = ?", [operationId]);
    expect(opRow?.moved_ids).toBe("");

    // 旧 digest 失效：重复确认返回 conflict
    const replay = await confirmMerge(store, "project", "skills\\system\\skill", "Target", digest, [], "admin");
    expect(replay.status).toBe("conflict");

    const reverted = await revertMerge(store, operationId, "admin");
    expect(reverted.status).toBe("reverted");
    expect(reverted.reverted).toBe(2);
    expect(await pendingCount(store, "project", "skills\\system\\skill")).toBe(2);
    expect(await pendingCount(store, "project", "Target")).toBe(1);

    const again = await revertMerge(store, operationId, "admin");
    expect(again.status).toBe("already-reverted");

    const listed = await listMergeOperations(store, 10, 0);
    expect(listed.total).toBe(1);
    expect((listed.operations as Array<{ status: string }>)[0]?.status).toBe("reverted");
    await db.close();
  });

  it("conflicts when the scope changed after preview", async () => {
    const { db, store, service } = await setup();
    await queue(service, "归并前材料", "bad\\path");
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    const digest = String(view.digest);
    await queue(service, "预览之后新来的材料", "bad\\path");
    const applied = await confirmAll(store, "project", "bad\\path", "Good", digest, "admin");
    expect(applied.status).toBe("conflict");
    expect(await pendingCount(store, "project", "bad\\path")).toBe(2);
    expect(await pendingCount(store, "project", "Good")).toBe(0);
    await db.close();
  });

  /** P0-05：等数量替换集合、同批一条离队、目标记忆 rev 变化都必须让旧 digest 失效。 */
  it("digest binds the exact batch ids not count or rowid", async () => {
    const { db, store, service } = await setup();
    const first = await queue(service, "集合成员甲", "bad\\path");
    const second = await queue(service, "集合成员乙", "bad\\path");
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    const digest = String(view.digest);

    // 等数量替换：数量不变但 ID 集合变化，必须 conflict
    await service.rejectInbox(first, "admin");
    const replacement = await queue(service, "替换进来的新成员", "bad\\path");
    expect(replacement).not.toBe(second);
    const applied = await confirmAll(store, "project", "bad\\path", "Good", digest, "admin");
    expect(applied.status).toBe("conflict");
    expect(await pendingCount(store, "project", "bad\\path")).toBe(2);

    // 同批一条离队
    const view2 = await previewMerge(store, "project", "bad\\path", "Good");
    const digest2 = String(view2.digest);
    const done = await service.confirmSources({ ids: [replacement], body: "蒸馏消费了一条", actor: "admin", expectedRev: 0 });
    expect(done.status).toBe("stored");
    const applied2 = await confirmAll(store, "project", "bad\\path", "Good", digest2, "admin");
    expect(applied2.status).toBe("conflict");

    // 目标记忆 rev 变化
    const view3 = await previewMerge(store, "project", "bad\\path", "Good");
    const digest3 = String(view3.digest);
    const advanced = await service.remember({ body: "目标被写入新版本", source: "mcp:x", actor: "x", scopeKind: "project", scopeId: "Good", expectedRev: 0 });
    expect(advanced.status).toBe("stored");
    const applied3 = await confirmAll(store, "project", "bad\\path", "Good", digest3, "admin");
    expect(applied3.status).toBe("conflict");

    // 新增目标草稿：digest 变化 → conflict，新预览带 blocked
    const view4 = await previewMerge(store, "project", "bad\\path", "Good");
    const digest4 = String(view4.digest);
    await store.upsertDraft({
      id: "dd_digest",
      scopeKind: "project",
      scopeId: "Good",
      title: "目标草稿",
      body: "目标草稿正文",
      sourceIds: [],
      sourceFingerprints: [],
      expectedRev: 0,
      provider: "stub",
      model: "stub",
      status: "pending",
      staleReason: "",
      error: "",
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const applied4 = await confirmAll(store, "project", "bad\\path", "Good", digest4, "admin");
    expect(applied4.status).toBe("conflict");
    expect(((applied4.preview as { blocked?: string[] }).blocked ?? []).length).toBeGreaterThan(0);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(1);
    await db.close();
  });

  it("blocks on pending drafts of either scope", async () => {
    const { db, store, service } = await setup();
    await queue(service, "有待审草稿的材料", "bad\\path");
    const draft = {
      id: "dd_block",
      scopeKind: "project",
      scopeId: "bad\\path",
      title: "旧草稿",
      body: "旧草稿正文",
      sourceIds: [],
      sourceFingerprints: [],
      expectedRev: 0,
      provider: "stub",
      model: "stub",
      status: "pending" as const,
      staleReason: "",
      error: "",
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsertDraft(draft);
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    expect((view.blocked as string[]).length).toBeGreaterThan(0);
    const applied = await confirmAll(store, "project", "bad\\path", "Good", String(view.digest), "admin");
    expect(applied.status).toBe("blocked");
    expect(await pendingCount(store, "project", "bad\\path")).toBe(1);
    await db.close();
  });

  /** P0-03：归并/撤销绝不移动或删除指纹行；同键副本与新增指纹也都原地保留。 */
  it("merge and revert leave fingerprint rows untouched", async () => {
    const { db, store, service } = await setup();
    const files = [{ path: "C:/work/Demo/AGENTS.md", text: "同键同内容的仓库约定", scopeId: "bad\\path" }];
    const first = await service.ingestCollected("projects", files);
    expect(first.queued).toBe(1);
    await store.insertFingerprint({
      collector: "projects",
      sourceKey: "C:/work/Demo/AGENTS.md",
      scopeKind: "project",
      scopeId: "Target",
      contentHash: (await import("../util.js")).sha256("同键同内容的仓库约定"),
      rulesVersion: 1,
      lastStatus: "older",
    });
    await queue(service, "来源作用域的普通材料", "bad\\path");
    const grown = await service.ingestCollected("projects", [{ path: "C:/work/Demo/README.md", text: "目标项目新增扫描文件", scopeId: "Target" }]);
    expect(grown.queued).toBe(1);

    const before = await fingerprintRows(store);
    expect(before).toHaveLength(3);

    const view = await previewMerge(store, "project", "bad\\path", "Target");
    const applied = await confirmAll(store, "project", "bad\\path", "Target", String(view.digest), "admin");
    expect(applied.status).toBe("applied");
    expect(await fingerprintRows(store)).toEqual(before);

    const reverted = await revertMerge(store, String(applied.operationId), "admin");
    expect(reverted.status).toBe("reverted");
    expect(await fingerprintRows(store)).toEqual(before);

    const after = await fingerprintRows(store);
    expect(after.filter((row) => row.scope_id === "bad\\path")).toHaveLength(1);
    expect(after.filter((row) => row.scope_id === "Target")).toHaveLength(2);
    await db.close();
  });

  /** P0-03：两次不同来源归并同一目标，依次确认/撤销后指纹行集合逐字段不变。 */
  it("two sequential merges keep fingerprints intact", async () => {
    const { db, store, service } = await setup();
    await queue(service, "来源甲的材料", "bad\\one");
    await queue(service, "来源乙的材料", "bad\\two");
    const target = await service.remember({ body: "目标已有记忆", source: "mcp:a", actor: "a", scopeKind: "project", scopeId: "Target", expectedRev: 0 });
    expect(target.status).toBe("stored");
    await service.ingestCollected("projects", [{ path: "C:/work/Demo/NOTES.md", text: "目标扫描文件内容", scopeId: "Target" }]);
    const before = await fingerprintRows(store);

    const view1 = await previewMerge(store, "project", "bad\\one", "Target");
    const applied1 = await confirmAll(store, "project", "bad\\one", "Target", String(view1.digest), "admin");
    expect(applied1.status).toBe("applied");
    const view2 = await previewMerge(store, "project", "bad\\two", "Target");
    const applied2 = await confirmAll(store, "project", "bad\\two", "Target", String(view2.digest), "admin");
    expect(applied2.status).toBe("applied");
    expect(await fingerprintRows(store)).toEqual(before);

    const reverted2 = await revertMerge(store, String(applied2.operationId), "admin");
    expect(reverted2.status).toBe("reverted");
    const reverted1 = await revertMerge(store, String(applied1.operationId), "admin");
    expect(reverted1.status).toBe("reverted");
    expect(await fingerprintRows(store)).toEqual(before);
    await db.close();
  });

  /** P0-06：一次确认最多 1000 条，剩余分批；每批独立可撤销，撤销一批不影响其他批。 */
  it("confirm moves at most the batch limit per operation", async () => {
    const { db, store, service } = await setup();
    for (let index = 0; index < 1005; index += 1) {
      await queue(service, `批量材料第 ${String(index).padStart(5, "0")} 号，内容足够长以通过限制`, "bad\\path");
    }
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    expect(view.pending).toBe(1005);
    expect(view.batch).toBe(1000);
    expect(view.remaining).toBe(5);
    expect(view.batchLimit).toBe(1000);
    expect(((view.batchItems ?? []) as unknown[]).length).toBe(1000);

    const applied1 = await confirmAll(store, "project", "bad\\path", "Good", String(view.digest), "admin");
    expect(applied1.status).toBe("applied");
    expect(applied1.moved).toBe(1000);
    expect(applied1.remaining).toBe(5);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(5);
    expect(await pendingCount(store, "project", "Good")).toBe(1000);

    const view2 = await previewMerge(store, "project", "bad\\path", "Good");
    expect(view2.batch).toBe(5);
    expect(view2.remaining).toBe(0);
    const applied2 = await confirmAll(store, "project", "bad\\path", "Good", String(view2.digest), "admin");
    expect(applied2.status).toBe("applied");
    expect(applied2.moved).toBe(5);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(0);

    // 撤销第二批不影响第一批
    const reverted2 = await revertMerge(store, String(applied2.operationId), "admin");
    expect(reverted2.status).toBe("reverted");
    expect(reverted2.reverted).toBe(5);
    expect(await pendingCount(store, "project", "Good")).toBe(1000);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(5);

    // 撤销第一批：精确 1000 条全部移回
    const reverted1 = await revertMerge(store, String(applied1.operationId), "admin");
    expect(reverted1.status).toBe("reverted");
    expect(reverted1.reverted).toBe(1000);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(1005);
    expect(await pendingCount(store, "project", "Good")).toBe(0);
    await db.close();
  }, 60_000);

  /** P0-03：归并后重扫不重复入队（含作用域变化），内容变化恰好新入队一次。 */
  it("rescan after merge stays quiet until content changes", async () => {
    const { db, store, service } = await setup();
    const files = [{ path: "C:/work/Demo/AGENTS.md", text: "仓库约定材料内容", scopeId: "bad\\path" }];
    const first = await service.ingestCollected("projects", files);
    expect(first.queued).toBe(1);
    const view = await previewMerge(store, "project", "bad\\path", "Target");
    const applied = await confirmAll(store, "project", "bad\\path", "Target", String(view.digest), "admin");
    expect(applied.status).toBe("applied");

    const rescan = await service.ingestCollected("projects", files);
    expect(rescan.queued).toBe(0);
    expect(rescan.skipped).toBe(1);

    // 采集器上报作用域变化：稳定来源键跨作用域命中同一文件，仍跳过
    const movedScope = [{ path: "C:/work/Demo/AGENTS.md", text: "仓库约定材料内容", scopeId: "Target" }];
    const rescanMoved = await service.ingestCollected("projects", movedScope);
    expect(rescanMoved.queued).toBe(0);
    expect(rescanMoved.skipped).toBe(1);

    // 内容变化：恰好新入队一次
    const changed = [{ path: "C:/work/Demo/AGENTS.md", text: "仓库约定材料内容版本二", scopeId: "Target" }];
    const rescanChanged = await service.ingestCollected("projects", changed);
    expect(rescanChanged.queued).toBe(1);
    const rescanAgain = await service.ingestCollected("projects", changed);
    expect(rescanAgain.queued).toBe(0);
    await db.close();
  });

  it("refuses revert when any moved item left the target scope", async () => {
    const { db, store, service } = await setup();
    const first = await queue(service, "撤销场景材料一", "bad\\path");
    await queue(service, "撤销场景材料二", "bad\\path");
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    const applied = await confirmAll(store, "project", "bad\\path", "Good", String(view.digest), "admin");
    expect(applied.status).toBe("applied");
    const done = await service.confirmSources({ ids: [first], body: "蒸馏后的整篇", actor: "admin", expectedRev: 0 });
    expect(done.status).toBe("stored");
    const refused = await revertMerge(store, String(applied.operationId), "admin");
    expect(refused.status).toBe("conflict");
    expect(await pendingCount(store, "project", "Good")).toBe(1);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(0);
    await db.close();
  });

  it("rejects invalid targets without touching the ledger", async () => {
    const { db, store, service } = await setup();
    await queue(service, "材料", "bad\\path");
    for (const bad of ["", "a\\b", "E:\\x", ".", "..", "bad\\path"]) {
      const result = await confirmMerge(store, "project", "bad\\path", bad, "digest", ["in_dummy"], "admin");
      expect(result.status).toBe("error");
    }
    expect(await pendingCount(store, "project", "bad\\path")).toBe(1);
    await db.close();
  });

  /** B-07：确认只移动显式勾选的精确 ID 子集；不勾选不能归并；未勾选的留在原队列。 */
  it("confirm moves only the reviewed id subset", async () => {
    const { db, store, service } = await setup();
    const belongA = await queue(service, "属于目标仓库的材料", "bad\\path");
    await queue(service, "混进来的其他仓库材料", "bad\\path");
    await queue(service, "尚未核对的材料", "bad\\path");
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    expect(view.batch).toBe(3);
    const digest = String(view.digest);

    const empty = await confirmMerge(store, "project", "bad\\path", "Good", digest, [], "admin");
    expect(empty.status).toBe("error");
    const dup = await confirmMerge(store, "project", "bad\\path", "Good", digest, [belongA, belongA], "admin");
    expect(dup.status).toBe("error");

    const applied = await confirmMerge(store, "project", "bad\\path", "Good", digest, [belongA], "admin");
    expect(applied.status).toBe("applied");
    expect(applied.moved).toBe(1);
    expect(await pendingCount(store, "project", "Good")).toBe(1);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(2);
    const opItems = await store.dbAll<{ inbox_id: string }>("SELECT inbox_id FROM scope_merge_operation_items WHERE operation_id = ?", [
      String(applied.operationId),
    ]);
    expect(opItems.map((row) => row.inbox_id)).toEqual([belongA]);

    const reverted = await revertMerge(store, String(applied.operationId), "admin");
    expect(reverted.status).toBe("reverted");
    expect(reverted.reverted).toBe(1);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(3);
    expect(await pendingCount(store, "project", "Good")).toBe(0);
    await db.close();
  });

  /** C-01：来源作用域在本批之外新增/移走一条（本批 ID 不变）必须使旧预览失效。 */
  it("digest invalidates when out-of-batch source changes", async () => {
    const { db, store, service } = await setup();
    for (let index = 0; index < 4; index += 1) {
      await queue(service, `本批材料第 ${index} 条，内容足够长以通过限制`, "bad\\path");
    }
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    const digest = String(view.digest);
    await queue(service, "本批之外新增的材料，内容足够长以通过限制", "bad\\path");
    const stale = await confirmAll(store, "project", "bad\\path", "Good", digest, "admin");
    expect(stale.status).toBe("conflict");
    expect(await pendingCount(store, "project", "Good")).toBe(0);

    const view2 = await previewMerge(store, "project", "bad\\path", "Good");
    const digest2 = String(view2.digest);
    const firstId = ((view2.batchItems ?? []) as Array<{ id: string }>)[0]!.id;
    await service.rejectInbox(firstId, "admin");
    const stale2 = await confirmAll(store, "project", "bad\\path", "Good", digest2, "admin");
    expect(stale2.status).toBe("conflict");
    expect(await pendingCount(store, "project", "Good")).toBe(0);
    await db.close();
  });

  /** B-01：确认过程中一行 UPDATE 被跳过时，整个事务必须回滚——
   *  inbox、操作表、items、审计与事务前逐项一致；重试不造成第二次移动。 */
  it("confirm rolls back completely when an update is skipped mid-merge", async () => {
    const { db, store, service } = await setup();
    const skipId = await queue(service, "回滚场景材料一", "bad\\path");
    await queue(service, "回滚场景材料二", "bad\\path");
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    const digest = String(view.digest);
    const ids = ((view.batchItems ?? []) as Array<{ id: string }>).map((item) => item.id);

    await db.exec(`CREATE TRIGGER skip_one BEFORE UPDATE ON inbox WHEN NEW.id = '${skipId}' BEGIN SELECT RAISE(IGNORE); END;`);
    const result = await confirmMerge(store, "project", "bad\\path", "Good", digest, ids, "admin");
    await db.exec("DROP TRIGGER skip_one");
    expect(result.status).toBe("conflict");
    // 零部分提交：全部材料仍在来源、没有操作/明细/审计残留
    expect(await pendingCount(store, "project", "bad\\path")).toBe(2);
    expect(await pendingCount(store, "project", "Good")).toBe(0);
    const opCount = await store.dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM scope_merge_operations");
    expect(Number(opCount?.n ?? 0)).toBe(0);
    const itemCount = await store.dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM scope_merge_operation_items");
    expect(Number(itemCount?.n ?? 0)).toBe(0);
    const auditCount = await store.dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'scope.merge%'");
    expect(Number(auditCount?.n ?? 0)).toBe(0);

    // 状态未变，同一 digest 重试成功；重复请求不再移动
    const retry = await confirmMerge(store, "project", "bad\\path", "Good", digest, ids, "admin");
    expect(retry.status).toBe("applied");
    expect(retry.moved).toBe(2);
    const replay = await confirmMerge(store, "project", "bad\\path", "Good", digest, ids, "admin");
    expect(replay.status).toBe("conflict");
    await db.close();
  });

  /** B-01：撤销时操作状态行没有恰好更新 1 条（被触发器跳过）必须整体回滚；
   *  材料留在目标作用域、操作保持 applied，重复撤销不造成第二次移动。 */
  it("revert rolls back when the status row is not updated exactly once", async () => {
    const { db, store, service } = await setup();
    await queue(service, "状态行回滚材料一", "bad\\path");
    await queue(service, "状态行回滚材料二", "bad\\path");
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    const applied = await confirmAll(store, "project", "bad\\path", "Good", String(view.digest), "admin");
    expect(applied.status).toBe("applied");
    const operationId = String(applied.operationId);

    await db.exec(
      "CREATE TRIGGER skip_status BEFORE UPDATE ON scope_merge_operations WHEN NEW.status = 'reverted' BEGIN SELECT RAISE(IGNORE); END;",
    );
    const refused = await revertMerge(store, operationId, "admin");
    await db.exec("DROP TRIGGER skip_status");
    expect(refused.status).toBe("conflict");
    // inbox 移回与状态行更新同生共死：全部留在目标作用域，操作仍 applied
    expect(await pendingCount(store, "project", "Good")).toBe(2);
    expect(await pendingCount(store, "project", "bad\\path")).toBe(0);
    const op = await store.dbGet<{ status: string }>("SELECT status FROM scope_merge_operations WHERE id = ?", [operationId]);
    expect(op?.status).toBe("applied");

    // 触发器移除后撤销成功；重复撤销幂等
    const reverted = await revertMerge(store, operationId, "admin");
    expect(reverted.status).toBe("reverted");
    expect(reverted.reverted).toBe(2);
    const again = await revertMerge(store, operationId, "admin");
    expect(again.status).toBe("already-reverted");
    await db.close();
  });

  it("fingerprint damage report is read only and lists operations", async () => {
    const { db, store, service } = await setup();
    await queue(service, "报告场景材料", "bad\\path");
    const view = await previewMerge(store, "project", "bad\\path", "Good");
    const applied = await confirmAll(store, "project", "bad\\path", "Good", String(view.digest), "admin");
    expect(applied.status).toBe("applied");
    const report = await fingerprintDamageReport(store);
    expect(report.status).toBe("report");
    const ops = report.operations as Array<{ fromScope: string; toScope: string }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]?.fromScope).toBe("project:bad\\path");
    expect(ops[0]?.toScope).toBe("project:Good");
    expect(String(report.note)).toContain("备份");
    await db.close();
  });
});

async function pendingCount(store: Store, scopeKind: string, scopeId: string): Promise<number> {
  const row = await store.dbGet<{ n: number }>(
    "SELECT COUNT(*) AS n FROM inbox WHERE queue_status = 'proposed' AND scope_kind = ? AND scope_id = ?",
    [scopeKind, scopeId],
  );
  return Number(row?.n ?? 0);
}
