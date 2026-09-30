//! 作用域归并（TS 服务模式镜像）：预览 → 确认（单事务重校验，≤ MERGE_BATCH_LIMIT 一批）→ 条件撤销。
//! 语义与 Rust 侧 scope_merge.rs 一致：只移动 proposed 材料，正式记忆、
//! 已拒收材料与凭据不动；归并/撤销只改 inbox 作用域，绝不移动或删除 collect_fingerprints。
//! PostgreSQL 存储下治理功能显式返回 unsupported（P1-06），SQLite 是本轮交付路径。

import { newId, sha256 } from "../util.js";
import { MERGE_BATCH_LIMIT } from "../types.js";
import type { MergeOperationRecord, Store } from "./store.js";

const UNSUPPORTED_POSTGRES = { status: "unsupported", error: "治理功能（作用域归并）暂不支持 PostgreSQL 存储；请使用 SQLite 存储。" } as const;

/** B-01：写入开始后的业务冲突必须让事务回滚——驱动对正常返回一律 COMMIT，
 *  部分更新后返回 conflict 会把半套改动提交进库。用异常把回滚交给驱动，再在事务外还原载荷。 */
class RollbackConflict extends Error {
  constructor(readonly payload: Record<string, unknown>) {
    super("merge conflict requires rollback");
  }
}

export function isRepositoryScopeId(scopeId: string): boolean {
  const id = scopeId.trim();
  return id.length > 0 && [...id].length <= 120 && !storeLooksLikePath(id);
}

function storeLooksLikePath(scopeId: string): boolean {
  return scopeId.includes("/") || scopeId.includes("\\") || scopeId.includes(":") || scopeId === "." || scopeId === "..";
}

function unsupported(store: Store): Record<string, unknown> | undefined {
  return store.driver === "postgres" ? { ...UNSUPPORTED_POSTGRES } : undefined;
}

async function pendingCount(store: Store, scopeKind: string, scopeId: string): Promise<number> {
  const row = await store.dbGet<{ n: number }>(
    "SELECT COUNT(*) AS n FROM inbox WHERE queue_status = 'proposed' AND scope_kind = ? AND scope_id = ?",
    [scopeKind, scopeId],
  );
  return Number(row?.n ?? 0);
}

async function batchBreakdown(store: Store, batchIds: string[]): Promise<Record<string, number>> {
  const breakdown: Record<string, number> = {};
  if (!batchIds.length) return breakdown;
  const placeholders = batchIds.map(() => "?").join(",");
  const rows = await store.dbAll<{ source: string; n: number }>(
    `SELECT source, COUNT(*) AS n FROM inbox WHERE id IN (${placeholders}) GROUP BY source ORDER BY COUNT(*) DESC, source ASC`,
    batchIds,
  );
  for (const row of rows) breakdown[row.source] = Number(row.n ?? 0);
  return breakdown;
}

/** 预览展示用 top20 来源分布，其余合并为 otherCount/otherKinds（M-02）。 */
function breakdownTop20(breakdown: Record<string, number>): { top: Array<{ source: string; count: number }>; otherCount: number; otherKinds: number } {
  const entries = Object.entries(breakdown);
  const top = entries.slice(0, 20).map(([source, count]) => ({ source, count }));
  const total = Object.values(breakdown).reduce((sum, count) => sum + count, 0);
  const topSum = top.reduce((sum, item) => sum + item.count, 0);
  return { top, otherCount: total - topSum, otherKinds: Math.max(0, entries.length - 20) };
}

/** 本批 ID：按稳定 (created_at, id) 次序取前 MERGE_BATCH_LIMIT 条 proposed 材料。 */
async function nextBatch(store: Store, kind: string, id: string): Promise<{ ids: string[]; pending: number; remaining: number }> {
  const rows = await store.dbAll<{ id: string }>(
    "SELECT id FROM inbox WHERE queue_status = 'proposed' AND scope_kind = ? AND scope_id = ? ORDER BY created_at ASC, id ASC LIMIT ?",
    [kind, id, MERGE_BATCH_LIMIT],
  );
  const pending = await pendingCount(store, kind, id);
  return { ids: rows.map((row) => row.id), pending, remaining: pending - rows.length };
}

async function pendingDraftRows(store: Store, fromId: string, toId: string): Promise<Array<{ scopeId: string; id: string; status: string; updatedAt: string; staleReason: string }>> {
  const rows = await store.dbAll<{ scope_id: string; id: string; status: string; updated_at: string; stale_reason: string }>(
    `SELECT scope_id, id, status, updated_at, stale_reason FROM distill_drafts
     WHERE status = 'pending' AND scope_kind = 'project' AND (scope_id = ? OR scope_id = ?)
     ORDER BY updated_at DESC LIMIT 10`,
    [fromId, toId],
  );
  return rows.map((row) => ({ scopeId: row.scope_id, id: row.id, status: row.status, updatedAt: row.updated_at, staleReason: row.stale_reason ?? "" }));
}

/**
 * 归并前状态摘要：绑定本批精确 ID 集合与来源/目标现状（P0-05/C-01）。
 * v3 相比 v2 增加来源作用域总 pending 数：来源在本批之外新增/移走一条时，
 * 本批 ID 不变但总数变化，旧预览同样失效。
 */
async function stateDigest(store: Store, fromKind: string, fromId: string, toId: string): Promise<string> {
  const { ids, pending } = await nextBatch(store, fromKind, fromId);
  const toPending = await pendingCount(store, "project", toId);
  const memory = await store.dbGet<{ id: string; rev: number }>(
    "SELECT id, rev FROM memories WHERE status = 'active' AND scope_kind = 'project' AND scope_id = ? ORDER BY updated_at DESC LIMIT 1",
    [toId],
  );
  const drafts = await pendingDraftRows(store, fromId, toId);
  const lines = [
    "oneledger-merge-digest-v3",
    `from:${fromKind}\u0000${fromId}`,
    `to:${toId}`,
    `fromPending:${pending}`,
    `batch:${ids.length}`,
    ...ids,
    `toPending:${toPending}`,
    `toMemory:${memory?.id ?? ""}:${Number(memory?.rev ?? 0)}`,
    `drafts:${drafts.map((draft) => draft.id).join(",")}`,
  ];
  return sha256(lines.join("\n"));
}

function basicChecks(fromKind: string, fromId: string, toId: string): string | undefined {
  if (fromKind !== "project") return "只支持归并 project 作用域的材料";
  if (!fromId.trim()) return "来源作用域不能为空";
  if (!isRepositoryScopeId(toId)) return "目标作用域必须是仓库名：不能为空，也不能含路径分隔符、盘符或 . / .. 片段";
  if (fromId === toId) return "来源与目标作用域相同，无需归并";
  return undefined;
}

/** 归并预览：只读。返回本批数量与剩余、来源分布、目标现状、草稿阻断、本批样本与提交时要带的 digest。 */
export async function previewMerge(store: Store, fromKind: string, fromId: string, toId: string): Promise<Record<string, unknown>> {
  const blocked = unsupported(store);
  if (blocked) return blocked;
  const target = toId.trim();
  const failed = basicChecks(fromKind, fromId, target);
  if (failed) return { status: "error", error: failed };
  const pending = await pendingCount(store, fromKind, fromId);
  if (!pending) return { status: "error", error: "来源作用域没有待蒸馏材料" };
  const { ids, remaining } = await nextBatch(store, fromKind, fromId);
  const breakdown = await batchBreakdown(store, ids);
  const { top, otherCount, otherKinds } = breakdownTop20(breakdown);
  // B-07：本批全部条目的脱敏元数据（≤1000 条），供管理员分页/筛选逐条核对归属，
  // 只勾选可证明属于目标仓库的 ID；确认只移动显式选中的子集。
  const batchRows = await store.inboxByIds(ids);
  const batchItems = batchRows.map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    createdAt: item.createdAt,
    sensitivity: item.sensitivity,
  }));
  const toPending = await pendingCount(store, "project", target);
  const toMemory = await store.dbGet<{ id: string; rev: number; updated_at: string }>(
    "SELECT id, rev, updated_at FROM memories WHERE status = 'active' AND scope_kind = 'project' AND scope_id = ? ORDER BY updated_at DESC LIMIT 1",
    [target],
  );
  const drafts = await pendingDraftRows(store, fromId, target);
  const digest = await stateDigest(store, fromKind, fromId, target);
  const blockedReasons: string[] = [];
  if (drafts.length) blockedReasons.push("来源或目标作用域存在待审核草稿；请先废弃或处理该草稿，避免旧草稿把材料写回错误作用域。");
  return {
    status: "ok",
    fromScopeKind: fromKind,
    fromScopeId: fromId,
    toScopeId: target,
    pending,
    batch: ids.length,
    remaining,
    batchLimit: MERGE_BATCH_LIMIT,
    sourceBreakdown: top,
    otherCount,
    otherKinds,
    batchItems,
    toPending,
    toMemory: toMemory ? { id: toMemory.id, rev: Number(toMemory.rev), updatedAt: toMemory.updated_at } : null,
    drafts,
    blocked: blockedReasons,
    digest,
  };
}

/**
 * 确认归并一批（≤ MERGE_BATCH_LIMIT 条）中管理员显式勾选的精确 ID 子集。
 * B-07：请求必须带非空、无重复、且全部落在本批（digest 绑定的精确 ID 集合）内的 ids，
 * 确认只移动这批已审核 ID；单事务内重校验 digest，任何写入开始后的失败都抛出回滚（B-01）。
 */
export async function confirmMerge(
  store: Store,
  fromKind: string,
  fromId: string,
  toId: string,
  digest: string,
  selectedIds: string[],
  actor: string,
): Promise<Record<string, unknown>> {
  const blocked = unsupported(store);
  if (blocked) return blocked;
  const target = toId.trim();
  const failed = basicChecks(fromKind, fromId, target);
  if (failed) return { status: "error", error: failed };
  if (!digest) return { status: "error", error: "缺少预览摘要 digest，请先预览" };
  const unique = [...new Set(selectedIds)];
  if (unique.length !== selectedIds.length) {
    return { status: "error", error: "勾选的材料 ID 有重复，请重新核对" };
  }
  if (selectedIds.length > MERGE_BATCH_LIMIT) {
    return { status: "error", error: `一次最多归并 ${MERGE_BATCH_LIMIT} 条` };
  }
  try {
    return await store.transaction(async (tx) => {
      const currentDigest = await stateDigest(tx, fromKind, fromId, target);
      if (currentDigest !== digest) {
        const fresh = await previewMerge(tx, fromKind, fromId, target);
        return { status: "conflict", error: "作用域状态已变化，请核对新预览后重试", preview: fresh };
      }
      const drafts = await pendingDraftRows(tx, fromId, target);
      if (drafts.length) {
        return { status: "blocked", error: "来源或目标作用域存在待审核草稿，先废弃或处理后再归并", drafts };
      }
      const { ids } = await nextBatch(tx, fromKind, fromId);
      if (!ids.length) return { status: "conflict", error: "来源作用域已没有待蒸馏材料" };
      if (!selectedIds.length) {
        return { status: "error", error: "请先在预览清单中勾选经核对属于目标仓库的材料；默认不选择，不勾选不能归并" };
      }
      const batchSet = new Set(ids);
      const missing = selectedIds.filter((id) => !batchSet.has(id));
      if (missing.length) {
        const fresh = await previewMerge(tx, fromKind, fromId, target);
        return {
          status: "conflict",
          error: `有 ${missing.length} 条勾选材料不在当前批次中（预览后批次已变化），请重新预览`,
          preview: fresh,
        };
      }
      // 分布按显式勾选子集统计（全量来源，无截断）
      const breakdown = await batchBreakdown(tx, selectedIds);
      const moved = await tx.dbRun(
        `UPDATE inbox SET scope_kind = 'project', scope_id = ?
         WHERE id IN (${selectedIds.map(() => "?").join(",")}) AND queue_status = 'proposed' AND scope_kind = ? AND scope_id = ?`,
        [target, ...selectedIds, fromKind, fromId],
      );
      if (moved !== selectedIds.length) {
        // B-01：UPDATE 可能已部分生效，必须抛出让驱动回滚，不能把半套改动提交进库
        throw new RollbackConflict({ status: "conflict", error: "作用域状态在归并过程中发生变化，已整体回滚" });
      }
      const operationId = newId("sm");
      const operation: MergeOperationRecord = {
        id: operationId,
        fromScopeKind: fromKind,
        fromScopeId: fromId,
        toScopeKind: "project",
        toScopeId: target,
        movedIds: [...selectedIds],
        movedCount: selectedIds.length,
        sourceBreakdown: breakdown,
        status: "applied",
        createdAt: new Date().toISOString(),
        revertedAt: null,
      };
      await tx.insertMergeOperation(operation);
      await tx.audit(actor, "scope.merge", `${fromKind}:${fromId} -> project:${target} moved=${selectedIds.length} batch=${ids.length}`);
      const remaining = await pendingCount(tx, fromKind, fromId);
      return { status: "applied", operationId, moved: selectedIds.length, toScopeId: target, remaining };
    });
  } catch (error) {
    if (error instanceof RollbackConflict) return error.payload;
    return { status: "error", error: `归并失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 撤销一次归并：只把该操作 item 表记录、仍处于目标作用域 proposed 状态的材料移回。 */
export async function revertMerge(store: Store, operationId: string, actor: string): Promise<Record<string, unknown>> {
  const blocked = unsupported(store);
  if (blocked) return blocked;
  try {
    return await store.transaction(async (tx) => {
      const operation = await tx.getMergeOperation(operationId);
      if (!operation) return { status: "error", error: "操作记录不存在" };
      if (operation.status === "reverted") return { status: "already-reverted", operationId: operation.id, reverted: 0 };
      if (operation.status !== "applied") return { status: "error", error: `操作状态为 ${operation.status}，无法撤销` };
      if (!operation.movedIds.length) {
        return { status: "error", error: "操作缺少批次明细（scope_merge_operation_items），无法撤销" };
      }
      // 用 SQL JOIN 直接核查该批，任何一条已离队则整批拒绝。
      const movableRow = await tx.dbGet<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inbox i JOIN scope_merge_operation_items s
           ON i.id = s.inbox_id AND s.operation_id = ?
         WHERE i.queue_status = 'proposed' AND i.scope_kind = ? AND i.scope_id = ?`,
        [operation.id, operation.toScopeKind, operation.toScopeId],
      );
      const stillMovable = Number(movableRow?.n ?? 0);
      if (stillMovable !== operation.movedIds.length) {
        return {
          status: "conflict",
          error: `有 ${operation.movedIds.length - stillMovable} 条材料已不在目标作用域的待处理状态（可能已被蒸馏、删除或再次移动），不能自动撤销；已写入正式记忆的内容不受影响`,
          movedCount: operation.movedIds.length,
          stillMovable,
        };
      }
      const movedBack = await tx.dbRun(
        `UPDATE inbox SET scope_kind = ?, scope_id = ?
         WHERE id IN (SELECT inbox_id FROM scope_merge_operation_items WHERE operation_id = ?)
           AND queue_status = 'proposed' AND scope_kind = ? AND scope_id = ?`,
        [operation.fromScopeKind, operation.fromScopeId, operation.id, operation.toScopeKind, operation.toScopeId],
      );
      if (movedBack !== operation.movedIds.length) {
        // B-01：UPDATE 可能已部分生效，必须抛出让驱动回滚
        throw new RollbackConflict({ status: "conflict", error: "撤销过程中状态变化，已整体回滚" });
      }
      const marked = await tx.dbRun(
        "UPDATE scope_merge_operations SET status = 'reverted', reverted_at = ? WHERE id = ? AND status = 'applied'",
        [new Date().toISOString(), operation.id],
      );
      if (marked !== 1) {
        // B-01：操作状态行必须恰好更新 1 条，否则抛出回滚，操作表/items/inbox/审计同生共死
        throw new RollbackConflict({ status: "conflict", error: "操作状态已变化，已整体回滚" });
      }
      await tx.audit(actor, "scope.merge.revert", `${operation.id} moved=${movedBack} back to ${operation.fromScopeKind}:${operation.fromScopeId}`);
      return { status: "reverted", operationId: operation.id, reverted: movedBack };
    });
  } catch (error) {
    if (error instanceof RollbackConflict) return error.payload;
    return { status: "error", error: `撤销失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function listMergeOperations(store: Store, limit: number, offset: number): Promise<Record<string, unknown>> {
  const blocked = unsupported(store);
  if (blocked) return blocked;
  const { rows, total } = await store.listMergeOperations(limit, offset);
  return { operations: rows, total };
}

/** 只读检测报告：v10 期间错误归并的指纹核查线索；被删除的指纹无法恢复，列为人工复核。 */
export async function fingerprintDamageReport(store: Store): Promise<Record<string, unknown>> {
  const blocked = unsupported(store);
  if (blocked) return blocked;
  const rows = await store.dbAll<{
    id: string;
    from_scope_kind: string;
    from_scope_id: string;
    to_scope_kind: string;
    to_scope_id: string;
    moved_count: number;
    status: string;
    created_at: string;
    reverted_at: string | null;
  }>("SELECT id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_count, status, created_at, reverted_at FROM scope_merge_operations ORDER BY created_at ASC");
  const operations = [];
  for (const row of rows) {
    const fpFrom = await store.dbGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM collect_fingerprints WHERE scope_kind = ? AND scope_id = ?",
      [row.from_scope_kind, row.from_scope_id],
    );
    const fpTo = await store.dbGet<{ n: number }>(
      "SELECT COUNT(*) AS n FROM collect_fingerprints WHERE scope_kind = ? AND scope_id = ?",
      [row.to_scope_kind, row.to_scope_id],
    );
    operations.push({
      operationId: row.id,
      fromScope: `${row.from_scope_kind}:${row.from_scope_id}`,
      toScope: `${row.to_scope_kind}:${row.to_scope_id}`,
      movedCount: Number(row.moved_count ?? 0),
      status: row.status,
      createdAt: row.created_at,
      revertedAt: row.reverted_at,
      fingerprintsNowInFromScope: Number(fpFrom?.n ?? 0),
      fingerprintsNowInToScope: Number(fpTo?.n ?? 0),
    });
  }
  return {
    status: "report",
    note: "v10 期间的归并曾搬移/删除 collect_fingerprints 行；被删除的指纹无法凭操作记录恢复。以下操作涉及的来源/目标作用域指纹需人工核对：确认来源文件是否被错误去重（丢失指纹会导致重扫重复入队，可重新采集；重复指纹会掩盖新版本，需比对 content_hash）。执行任何修复前必须先完成全量备份。",
    operations,
  };
}
