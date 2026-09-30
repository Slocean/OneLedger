import type { Db } from "../db/driver.js";
import type { AgentRecord, ApiKeyRecord, InboxRecord, MemoryRecord, QueueStatus, ScopeFilter } from "../types.js";
import type { DistillDraft } from "./distillJob.js";
import { newId, nowIso } from "../util.js";

interface MemoryRow {
  id: string;
  rev: number;
  title: string;
  body: string;
  scope_kind: MemoryRecord["scopeKind"];
  scope_id: string;
  sensitivity: MemoryRecord["sensitivity"];
  status: MemoryRecord["status"];
  source: string;
  origin_node: string;
  content_hash: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  forgotten_at: string | null;
}

interface KeyRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes: string;
  tools: string;
  created_at: string;
  last_used_at: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  kind: AgentRecord["kind"];
  builtin: number;
  enabled: number;
  root_path: string;
  last_scanned_at: string | null;
  last_scanned_files: number;
  last_ingested: number;
  last_queued: number;
  last_redacted: number;
  last_error: string;
  created_at: string;
}

interface InboxRow {
  id: string;
  title: string;
  body: string;
  source: string;
  scope_kind: InboxRecord["scopeKind"];
  scope_id: string;
  sensitivity: InboxRecord["sensitivity"];
  redacted: number;
  queue_status?: QueueStatus;
  conflict_ids?: string;
  created_at: string;
  source_key?: string;
}

interface DraftRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  title: string;
  body: string;
  source_ids: string;
  source_fingerprints: string;
  expected_rev: number;
  provider: string;
  model: string;
  status: DistillDraft["status"];
  stale_reason: string;
  error: string;
  attempts: number;
  created_at: string;
  updated_at: string;
}

function splitList(value: string): string[] {
  return value.split("\u001f").filter(Boolean);
}

function mapDraft(row: DraftRow): DistillDraft {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    title: row.title,
    body: row.body,
    sourceIds: splitList(row.source_ids),
    sourceFingerprints: splitList(row.source_fingerprints),
    expectedRev: Number(row.expected_rev ?? 0),
    provider: row.provider,
    model: row.model,
    status: row.status,
    staleReason: row.stale_reason ?? "",
    error: row.error ?? "",
    attempts: Number(row.attempts ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    rev: row.rev,
    title: row.title,
    body: row.body,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    sensitivity: row.sensitivity,
    status: row.status,
    source: row.source,
    originNode: row.origin_node,
    contentHash: row.content_hash,
    supersededBy: row.superseded_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at,
  };
}

function mapKey(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    tools: row.tools,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    builtin: Number(row.builtin) === 1,
    enabled: Number(row.enabled) === 1,
    rootPath: row.root_path,
    lastScannedAt: row.last_scanned_at,
    lastScannedFiles: Number(row.last_scanned_files ?? 0),
    lastIngested: Number(row.last_ingested ?? 0),
    lastQueued: Number(row.last_queued ?? 0),
    lastRedacted: Number(row.last_redacted ?? 0),
    lastError: row.last_error ?? "",
    createdAt: row.created_at,
  };
}

function mapInbox(row: InboxRow): InboxRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    source: row.source,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    sensitivity: row.sensitivity,
    redacted: row.redacted,
    queueStatus: row.queue_status ?? "proposed",
    conflictIds: row.conflict_ids ? row.conflict_ids.split(",").filter(Boolean) : [],
    createdAt: row.created_at,
    sourceKey: row.source_key ?? "",
  };
}

function scopeWhere(base: string, filter?: ScopeFilter): { sql: string; params: unknown[] } {
  const clauses = [base];
  const params: unknown[] = [];
  if (filter?.scopeKind) {
    clauses.push("scope_kind = ?");
    params.push(filter.scopeKind);
  }
  if (filter?.scopeId) {
    clauses.push("scope_id = ?");
    params.push(filter.scopeId);
  }
  return { sql: `SELECT * FROM memories WHERE ${clauses.join(" AND ")}`, params };
}

export interface MergeOperationRecord {
  id: string;
  fromScopeKind: string;
  fromScopeId: string;
  toScopeKind: string;
  toScopeId: string;
  movedIds: string[];
  movedCount: number;
  sourceBreakdown: Record<string, number>;
  status: string;
  createdAt: string;
  revertedAt: string | null;
}

/** 列表只读概要（不含 movedIds 大字段）。 */
export interface MergeOperationSummary {
  id: string;
  fromScopeKind: string;
  fromScopeId: string;
  toScopeKind: string;
  toScopeId: string;
  movedCount: number;
  sourceBreakdown: Record<string, number>;
  status: string;
  createdAt: string;
  revertedAt: string | null;
}

export class Store {
  constructor(private readonly db: Db) {}

  /** 存储驱动名，供治理功能在 PostgreSQL 上显式返回 unsupported。 */
  get driver(): "sqlite" | "postgres" {
    return this.db.driver;
  }

  async transaction<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((db) => work(new Store(db)));
  }

  /** 底层只读查询（供 scopeMerge 等服务在事务内复用同一连接）。 */
  dbGet<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.get<T>(sql, params);
  }

  dbAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.all<T>(sql, params);
  }

  /** 执行写语句，返回受影响行数。 */
  dbRun(sql: string, params: unknown[] = []): Promise<number> {
    return this.db.run(sql, params);
  }

  async lockScope(scopeKind: string, scopeId: string): Promise<void> {
    if (this.db.driver === "postgres") {
      await this.db.get("SELECT pg_advisory_xact_lock(hashtext(?))", [`${scopeKind}:${scopeId}`]);
    }
  }

  async insertInbox(record: Omit<InboxRecord, "id" | "createdAt"> & { id?: string }): Promise<InboxRecord> {
    const row: InboxRecord = {
      id: record.id ?? newId("in"),
      createdAt: nowIso(),
      ...record,
    };
    await this.db.run(
      `INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.title,
        row.body,
        row.source,
        row.scopeKind,
        row.scopeId,
        row.sensitivity,
        row.redacted,
        row.createdAt,
        row.queueStatus,
        row.conflictIds.join(","),
        row.sourceKey,
      ],
    );
    return row;
  }

  async getInbox(id: string): Promise<InboxRecord | undefined> {
    const row = await this.db.get<InboxRow>("SELECT * FROM inbox WHERE id = ?", [id]);
    return row ? mapInbox(row) : undefined;
  }

  async findCollectedInbox(source: string, scopeKind: InboxRecord["scopeKind"], scopeId: string, body: string, sourceKey: string): Promise<InboxRecord | undefined> {
    // 材料级查重限定作用域（P0-04），且必须同一来源键（B-05）：
    // 同仓库两个不同文件（不同 source_key）同文时各自成一条。
    // 人工/历史行键为空串，只在键同为空串时互相匹配（保守，不擅自合并）。
    const row = await this.db.get<InboxRow>(
      "SELECT * FROM inbox WHERE source = ? AND scope_kind = ? AND scope_id = ? AND substr(body, 1, 128) = substr(?, 1, 128) AND body = ? AND source_key = ? ORDER BY id LIMIT 1",
      [source, scopeKind, scopeId, body, body, sourceKey],
    );
    return row ? mapInbox(row) : undefined;
  }

  async listInbox(limit = 20_000, status: QueueStatus = "proposed", offset = 0): Promise<InboxRecord[]> {
    const rows = await this.db.all<InboxRow>(
      "SELECT * FROM inbox WHERE queue_status = ? ORDER BY CASE WHEN lower(source) LIKE '%workbuddy%' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?",
      [status, limit, offset],
    );
    return rows.map(mapInbox);
  }

  /** project 作用域里像路径而不是仓库名的 scopeId。这只是待审标记，归并目标必须人工确认。 */
  scopeIdLooksLikePath(scopeId: string): boolean {
    return scopeId.includes("/") || scopeId.includes("\\") || scopeId.includes(":") || scopeId === "." || scopeId === "..";
  }

  /** 服务端分页的作用域聚合列表：SQL 内筛选与计数，不把全部作用域传给前端。 */
  async inboxScopePage(query: string, onlyAbnormal: boolean, limit: number, offset: number): Promise<{ rows: Array<{ scopeKind: string; scopeId: string; pending: number; workbuddy: number; oldestAt?: string }>; total: number }> {
    const abnormalClause = onlyAbnormal
      ? "HAVING scope_kind = 'project' AND (scope_id LIKE '%/%' OR scope_id LIKE '%\\%' OR scope_id LIKE '%:%' OR scope_id = '.' OR scope_id = '..')"
      : "HAVING scope_kind = scope_kind";
    const base = `FROM inbox WHERE queue_status = 'proposed'
        AND (?1 = '' OR scope_id LIKE '%' || ?1 || '%')
      GROUP BY scope_kind, scope_id
      ${abnormalClause}`;
    const totalRow = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT scope_kind ${base})`, [query]);
    const rows = await this.db.all<{ scope_kind: string; scope_id: string; pending: number; workbuddy: number; oldest_at: string | null }>(
      `SELECT scope_kind, scope_id,
              COUNT(*) AS pending,
              SUM(CASE WHEN lower(source) LIKE '%workbuddy%' THEN 1 ELSE 0 END) AS workbuddy,
              MIN(created_at) AS oldest_at
       ${base}
       ORDER BY MAX(created_at) DESC, scope_id ASC
       LIMIT ?2 OFFSET ?3`,
      [query, limit, offset],
    );
    return {
      rows: rows.map((row) => ({
        scopeKind: row.scope_kind,
        scopeId: row.scope_id,
        pending: Number(row.pending ?? 0),
        workbuddy: Number(row.workbuddy ?? 0),
        oldestAt: row.oldest_at ?? undefined,
      })),
      total: Number(totalRow?.n ?? 0),
    };
  }

  /** 服务端分页+筛选的材料明细。稳定次序 created_at DESC, id DESC。 */
  async inboxPage(status: QueueStatus, scopeKind: string, scopeId: string, source: string, limit: number, offset: number): Promise<{ rows: InboxRecord[]; total: number }> {
    const where = "WHERE queue_status = ?1 AND (?2 = '' OR scope_kind = ?2) AND (?3 = '' OR scope_id = ?3) AND (?4 = '' OR source = ?4)";
    const totalRow = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox ${where}`, [status, scopeKind, scopeId, source]);
    const rows = await this.db.all<InboxRow>(
      `SELECT * FROM inbox ${where} ORDER BY created_at DESC, id DESC LIMIT ?5 OFFSET ?6`,
      [status, scopeKind, scopeId, source, limit, offset],
    );
    return { rows: rows.map(mapInbox), total: Number(totalRow?.n ?? 0) };
  }

  /** 按精确 ID 集合取材料（供草稿审核展示草稿来源元数据）；顺序按传入次序。 */
  async inboxByIds(ids: string[]): Promise<InboxRecord[]> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = await this.db.all<InboxRow>(`SELECT * FROM inbox WHERE id IN (${placeholders})`, ids);
    const byId = new Map(rows.map((row) => [row.id, mapInbox(row)]));
    return ids.flatMap((id) => {
      const found = byId.get(id);
      byId.delete(id);
      return found ? [found] : [];
    });
  }

  /** 一次取回给定作用域集合各自的最新草稿。 */
  async latestDraftsForScopes(keys: Array<{ scopeKind: string; scopeId: string }>): Promise<Map<string, DistillDraft>> {
    const out = new Map<string, DistillDraft>();
    if (!keys.length) return out;
    let sql = `SELECT * FROM (
         SELECT distill_drafts.*,
                ROW_NUMBER() OVER (PARTITION BY scope_kind, scope_id ORDER BY updated_at DESC) AS scope_rank
         FROM distill_drafts
         WHERE (scope_kind, scope_id) IN (VALUES `;
    const params: string[] = [];
    keys.forEach((key, index) => {
      if (index > 0) sql += ",";
      sql += "(?, ?)";
      params.push(key.scopeKind, key.scopeId);
    });
    sql += ")) WHERE scope_rank = 1";
    const rows = await this.db.all<DraftRow>(sql, params);
    for (const row of rows) {
      const draft = mapDraft(row);
      out.set(`${draft.scopeKind}\u0000${draft.scopeId}`, draft);
    }
    return out;
  }

  async insertMergeOperation(record: MergeOperationRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO scope_merge_operations
         (id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_ids, moved_count, source_breakdown, status, created_at, reverted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.fromScopeKind,
        record.fromScopeId,
        record.toScopeKind,
        record.toScopeId,
        // 新操作不再把 ID 列表塞进单个 TEXT；批次明细在 scope_merge_operation_items。
        "",
        record.movedCount,
        JSON.stringify(record.sourceBreakdown),
        record.status,
        record.createdAt,
        record.revertedAt,
      ],
    );
    await this.insertMergeOperationItems(record.id, record.movedIds);
  }

  async insertMergeOperationItems(operationId: string, inboxIds: string[]): Promise<void> {
    for (const inboxId of inboxIds) {
      await this.db.run(
        "INSERT OR IGNORE INTO scope_merge_operation_items (operation_id, inbox_id) VALUES (?, ?)",
        [operationId, inboxId],
      );
    }
  }

  /** 撤销/详情用的完整操作（含 item 表批次 ID；旧记录回退到 moved_ids 文本）。 */
  async getMergeOperation(id: string): Promise<{ id: string; fromScopeKind: string; fromScopeId: string; toScopeKind: string; toScopeId: string; movedIds: string[]; movedCount: number; sourceBreakdown: Record<string, number>; status: string; createdAt: string; revertedAt: string | null } | undefined> {
    const row = await this.db.get<{ id: string; from_scope_kind: string; from_scope_id: string; to_scope_kind: string; to_scope_id: string; moved_ids: string; moved_count: number; source_breakdown: string; status: string; created_at: string; reverted_at: string | null }>(
      "SELECT * FROM scope_merge_operations WHERE id = ?",
      [id],
    );
    if (!row) return undefined;
    const items = await this.db.all<{ inbox_id: string }>(
      "SELECT inbox_id FROM scope_merge_operation_items WHERE operation_id = ?",
      [id],
    );
    return {
      id: row.id,
      fromScopeKind: row.from_scope_kind,
      fromScopeId: row.from_scope_id,
      toScopeKind: row.to_scope_kind,
      toScopeId: row.to_scope_id,
      movedIds: items.length ? items.map((item) => item.inbox_id) : (row.moved_ids ?? "").split("\u001f").filter(Boolean),
      movedCount: Number(row.moved_count ?? 0),
      sourceBreakdown: JSON.parse(row.source_breakdown || "{}") as Record<string, number>,
      status: row.status,
      createdAt: row.created_at,
      revertedAt: row.reverted_at,
    };
  }

  /** 列表只读概要字段：单次分页 SQL，不读 moved_ids 大字段，避免 N+1 与反序列化巨量 ID（M-03）。 */
  async listMergeOperations(limit: number, offset: number): Promise<{ rows: MergeOperationSummary[]; total: number }> {
    const totalRow = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scope_merge_operations");
    const rows = await this.db.all<{
      id: string;
      from_scope_kind: string;
      from_scope_id: string;
      to_scope_kind: string;
      to_scope_id: string;
      moved_count: number;
      source_breakdown: string;
      status: string;
      created_at: string;
      reverted_at: string | null;
    }>(
      `SELECT id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_count, source_breakdown, status, created_at, reverted_at
       FROM scope_merge_operations ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return {
      rows: rows.map((row) => ({
        id: row.id,
        fromScopeKind: row.from_scope_kind,
        fromScopeId: row.from_scope_id,
        toScopeKind: row.to_scope_kind,
        toScopeId: row.to_scope_id,
        movedCount: Number(row.moved_count ?? 0),
        sourceBreakdown: JSON.parse(row.source_breakdown || "{}") as Record<string, number>,
        status: row.status,
        createdAt: row.created_at,
        revertedAt: row.reverted_at,
      })),
      total: Number(totalRow?.n ?? 0),
    };
  }

  /** 仍待审核的草稿，供接口在返回任务前刷新过期状态。 */
  async pendingDrafts(): Promise<DistillDraft[]> {
    const rows = await this.db.all<DraftRow>("SELECT * FROM distill_drafts WHERE status = 'pending' ORDER BY updated_at DESC");
    return rows.map(mapDraft);
  }

  async inboxHitTypes(id: string): Promise<string[]> {
    const rows = await this.db.all<{ hit_type: string }>("SELECT DISTINCT hit_type FROM redaction_events WHERE inbox_id = ? ORDER BY hit_type", [id]);
    return rows.map((row) => row.hit_type);
  }

  /** 一次批量取回本页材料的命中规则（消除 N+1）。IN 分块避免 SQLite 变量上限。 */
  async inboxHitTypesBatch(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    for (let start = 0; start < ids.length; start += 400) {
      const chunk = ids.slice(start, start + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await this.db.all<{ inbox_id: string; hit_type: string }>(
        `SELECT inbox_id, hit_type FROM redaction_events WHERE inbox_id IN (${placeholders}) ORDER BY inbox_id, hit_type`,
        chunk,
      );
      for (const row of rows) {
        const list = out.get(row.inbox_id) ?? [];
        list.push(row.hit_type);
        out.set(row.inbox_id, list);
      }
    }
    return out;
  }

  async rejectInbox(id: string): Promise<void> {
    await this.db.run("UPDATE inbox SET queue_status = 'rejected' WHERE id = ?", [id]);
  }

  async deleteInbox(id: string): Promise<void> {
    await this.db.run("DELETE FROM inbox WHERE id = ?", [id]);
  }

  async findActiveByHash(hash: string, scopeKind: MemoryRecord["scopeKind"], scopeId: string): Promise<MemoryRecord | undefined> {
    const row = await this.db.get<MemoryRow>(
      "SELECT * FROM memories WHERE content_hash = ? AND status = 'active' AND scope_kind = ? AND scope_id = ? LIMIT 1",
      [hash, scopeKind, scopeId],
    );
    return row ? mapMemory(row) : undefined;
  }

  async listActiveByScope(scopeKind: MemoryRecord["scopeKind"], scopeId: string): Promise<MemoryRecord[]> {
    const rows = await this.db.all<MemoryRow>(
      "SELECT * FROM memories WHERE status = 'active' AND scope_kind = ? AND scope_id = ? ORDER BY updated_at DESC",
      [scopeKind, scopeId],
    );
    return rows.map(mapMemory);
  }

  async upsertMemory(record: MemoryRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO memories (
         id, rev, title, body, scope_kind, scope_id, sensitivity, status, source,
         origin_node, content_hash, created_at, updated_at, forgotten_at, superseded_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rev = excluded.rev,
         title = excluded.title,
         body = excluded.body,
         scope_kind = excluded.scope_kind,
         scope_id = excluded.scope_id,
         sensitivity = excluded.sensitivity,
         status = excluded.status,
         source = excluded.source,
         origin_node = excluded.origin_node,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at,
         forgotten_at = excluded.forgotten_at,
         superseded_by = excluded.superseded_by`,
      [
        record.id,
        record.rev,
        record.title,
        record.body,
        record.scopeKind,
        record.scopeId,
        record.sensitivity,
        record.status,
        record.source,
        record.originNode,
        record.contentHash,
        record.createdAt,
        record.updatedAt,
        record.forgottenAt,
        record.supersededBy,
      ],
    );
  }

  async getMemory(id: string): Promise<MemoryRecord | undefined> {
    const row = await this.db.get<MemoryRow>("SELECT * FROM memories WHERE id = ?", [id]);
    return row ? mapMemory(row) : undefined;
  }

  async listMemories(limit = 100, filter?: ScopeFilter): Promise<MemoryRecord[]> {
    const { sql, params } = scopeWhere("status != 'forgotten'", filter);
    const rows = await this.db.all<MemoryRow>(`${sql} ORDER BY updated_at DESC LIMIT ?`, [...params, limit]);
    return rows.map(mapMemory);
  }

  async listActive(limit = 200): Promise<MemoryRecord[]> {
    const rows = await this.db.all<MemoryRow>(
      "SELECT * FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?",
      [limit],
    );
    return rows.map(mapMemory);
  }

  async searchMemories(query: string, limit = 8, filter?: ScopeFilter): Promise<MemoryRecord[]> {
    const terms = query.split(/\s+/u).filter((term) => [...term].length >= 3).map((term) => `"${term.replaceAll('"', '""')}"`);
    if (this.db.driver === "sqlite" && terms.length) {
      const kind = filter?.scopeKind ?? "";
      const id = filter?.scopeId ?? "";
      const rows = await this.db.all<MemoryRow>(
        `SELECT memories.* FROM memories_fts JOIN memories ON memories.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND memories.status = 'active' AND memories.sensitivity != 'secret'
           AND (? = '' OR memories.scope_kind = ?) AND (? = '' OR memories.scope_id = ?)
         ORDER BY bm25(memories_fts), memories.updated_at DESC LIMIT ?`,
        [terms.join(" AND "), kind, kind, id, id, limit],
      );
      return rows.map(mapMemory);
    }
    const needle = `%${query.replaceAll("%", "")}%`;
    const { sql, params } = scopeWhere("status = 'active' AND sensitivity != 'secret'", filter);
    const rows = await this.db.all<MemoryRow>(
      `${sql} AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT ?`,
      [...params, needle, needle, limit],
    );
    return rows.map(mapMemory);
  }

  async changedSince(since: string): Promise<MemoryRecord[]> {
    const rows = await this.db.all<MemoryRow>(
      "SELECT * FROM memories WHERE updated_at > ? ORDER BY updated_at ASC",
      [since],
    );
    return rows.map(mapMemory);
  }

  async counts(): Promise<{ active: number; inbox: number; forgotten: number }> {
    const active = await this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memories WHERE status = 'active'",
    );
    const forgotten = await this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memories WHERE status = 'forgotten'",
    );
    const inbox = await this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM inbox WHERE queue_status = 'proposed'",
    );
    return {
      active: Number(active?.n ?? 0),
      inbox: Number(inbox?.n ?? 0),
      forgotten: Number(forgotten?.n ?? 0),
    };
  }

  async pruneHistory(): Promise<{ archivedEvents: number; removedRejected: number }> {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    return this.db.transaction(async (db) => {
      const oldEvents = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM redaction_events WHERE at < ?", [cutoff]);
      const oldRejected = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE queue_status = 'rejected' AND created_at < ?", [cutoff]);
      await db.run(
        `INSERT INTO redaction_archive(day, hit_type, count)
         SELECT substr(at, 1, 10), hit_type, COUNT(*) FROM redaction_events WHERE at < ?
         GROUP BY substr(at, 1, 10), hit_type
         ON CONFLICT(day, hit_type) DO UPDATE SET count = count + excluded.count`,
        [cutoff],
      );
      await db.run("DELETE FROM redaction_events WHERE at < ?", [cutoff]);
      await db.run("DELETE FROM inbox WHERE queue_status = 'rejected' AND created_at < ?", [cutoff]);
      return { archivedEvents: Number(oldEvents?.n ?? 0), removedRejected: Number(oldRejected?.n ?? 0) };
    });
  }

  async addRedaction(source: string, hitType: string, inboxId: string | null): Promise<void> {
    await this.db.run(
      "INSERT INTO redaction_events (id, at, source, hit_type, inbox_id) VALUES (?, ?, ?, ?, ?)",
      [newId("rd"), nowIso(), source, hitType, inboxId],
    );
  }

  async listRedactions(limit = 50) {
    return this.db.all(
      "SELECT id, at, source, hit_type FROM redaction_events ORDER BY at DESC LIMIT ?",
      [limit],
    );
  }

  async audit(actor: string, action: string, detail: string): Promise<void> {
    await this.db.run(
      "INSERT INTO audit_log (id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)",
      [newId("au"), nowIso(), actor, action, detail],
    );
  }

  async listAudit(limit = 50) {
    return this.db.all("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?", [limit]);
  }

  async insertKey(record: ApiKeyRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO api_keys (id, name, token_hash, token_prefix, scopes, tools, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.name,
        record.tokenHash,
        record.tokenPrefix,
        record.scopes,
        record.tools,
        record.createdAt,
        record.lastUsedAt,
      ],
    );
  }

  async findKeyByHash(tokenHash: string): Promise<ApiKeyRecord | undefined> {
    const row = await this.db.get<KeyRow>("SELECT * FROM api_keys WHERE token_hash = ?", [tokenHash]);
    return row ? mapKey(row) : undefined;
  }

  async listKeys(): Promise<ApiKeyRecord[]> {
    const rows = await this.db.all<KeyRow>("SELECT * FROM api_keys ORDER BY created_at DESC");
    return rows.map(mapKey);
  }

  async touchKey(id: string): Promise<void> {
    await this.db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [nowIso(), id]);
  }

  async getSyncCursor(): Promise<string> {
    const row = await this.db.get<{ value: string }>(
      "SELECT value FROM sync_meta WHERE key = 'cursor'",
    );
    return row?.value ?? "1970-01-01T00:00:00.000Z";
  }

  async getAgent(id: string): Promise<AgentRecord | undefined> {
    const row = await this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", [id]);
    return row ? mapAgent(row) : undefined;
  }

  async listAgents(): Promise<AgentRecord[]> {
    const rows = await this.db.all<AgentRow>("SELECT * FROM agents ORDER BY builtin DESC, name ASC");
    return rows.map(mapAgent);
  }

  async upsertAgent(record: AgentRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO agents (
         id, name, kind, builtin, enabled, root_path, last_scanned_at, last_scanned_files,
         last_ingested, last_queued, last_redacted, last_error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         kind = excluded.kind,
         builtin = excluded.builtin,
         enabled = excluded.enabled,
         root_path = excluded.root_path,
         last_scanned_at = excluded.last_scanned_at,
         last_scanned_files = excluded.last_scanned_files,
         last_ingested = excluded.last_ingested,
         last_queued = excluded.last_queued,
         last_redacted = excluded.last_redacted,
         last_error = excluded.last_error`,
      [
        record.id,
        record.name,
        record.kind,
        record.builtin ? 1 : 0,
        record.enabled ? 1 : 0,
        record.rootPath,
        record.lastScannedAt,
        record.lastScannedFiles,
        record.lastIngested,
        record.lastQueued,
        record.lastRedacted,
        record.lastError,
        record.createdAt,
      ],
    );
  }

  async deleteAgent(id: string): Promise<void> {
    await this.db.run("DELETE FROM agents WHERE id = ? AND builtin = 0", [id]);
  }

  /** 指纹触碰的单调序号：同毫秒时间戳并列时（C-02）取序号最大者为最新。 */
  private async nextFingerprintSeq(): Promise<number> {
    const row = await this.dbGet<{ v: string }>("SELECT value AS v FROM sync_meta WHERE key = 'fp_seq'");
    const next = Number(row?.v ?? 0) + 1;
    await this.dbRun(
      "INSERT INTO sync_meta (key, value) VALUES ('fp_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(next)],
    );
    return next;
  }

  async latestFingerprint(
    collector: string,
    sourceKey: string,
    scopeKind: string,
    scopeId: string,
    rulesVersion: number,
  ): Promise<{ id: string; contentHash: string; lastStatus: string } | undefined> {
    const row = await this.db.get<{ id: string; content_hash: string; last_status: string }>(
      `SELECT id, content_hash, last_status FROM collect_fingerprints
       WHERE collector = ? AND source_key = ? AND scope_kind = ? AND scope_id = ? AND rules_version = ?
       ORDER BY touched_seq DESC, rowid DESC LIMIT 1`,
      [collector, sourceKey, scopeKind, scopeId, rulesVersion],
    );
    return row ? { id: row.id, contentHash: row.content_hash, lastStatus: row.last_status } : undefined;
  }

  /** 跨作用域查最近指纹：只用于可证明跨作用域唯一的来源键（规范化后的绝对路径）。 */
  async latestFingerprintGlobal(
    collector: string,
    sourceKey: string,
    rulesVersion: number,
  ): Promise<{ id: string; contentHash: string; lastStatus: string } | undefined> {
    const row = await this.db.get<{ id: string; content_hash: string; last_status: string }>(
      `SELECT id, content_hash, last_status FROM collect_fingerprints
       WHERE collector = ? AND source_key = ? AND rules_version = ?
       ORDER BY touched_seq DESC, rowid DESC LIMIT 1`,
      [collector, sourceKey, rulesVersion],
    );
    return row ? { id: row.id, contentHash: row.content_hash, lastStatus: row.last_status } : undefined;
  }

  async touchFingerprint(id: string, lastStatus: string): Promise<void> {
    const seq = await this.nextFingerprintSeq();
    await this.db.run("UPDATE collect_fingerprints SET last_seen_at = ?, last_status = ?, touched_seq = ? WHERE id = ?", [
      nowIso(),
      lastStatus,
      seq,
      id,
    ]);
  }

  async insertFingerprint(record: {
    collector: string;
    sourceKey: string;
    scopeKind: string;
    scopeId: string;
    contentHash: string;
    rulesVersion: number;
    lastStatus: string;
  }): Promise<void> {
    const now = nowIso();
    const seq = await this.nextFingerprintSeq();
    await this.db.run(
      `INSERT INTO collect_fingerprints
         (id, collector, source_key, scope_kind, scope_id, content_hash, rules_version, last_status, first_seen_at, last_seen_at, touched_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (collector, source_key, scope_kind, scope_id, content_hash, rules_version)
       DO UPDATE SET last_seen_at = excluded.last_seen_at, last_status = excluded.last_status, touched_seq = excluded.touched_seq`,
      [
        newId("fp"),
        record.collector,
        record.sourceKey,
        record.scopeKind,
        record.scopeId,
        record.contentHash,
        record.rulesVersion,
        record.lastStatus,
        now,
        now,
        seq,
      ],
    );
  }

  async setSyncCursor(value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_meta (key, value) VALUES ('cursor', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [value],
    );
  }

  async latestDraft(scopeKind: string, scopeId: string): Promise<DistillDraft | undefined> {
    const row = await this.db.get<DraftRow>(
      "SELECT * FROM distill_drafts WHERE scope_kind = ? AND scope_id = ? ORDER BY updated_at DESC LIMIT 1",
      [scopeKind, scopeId],
    );
    return row ? mapDraft(row) : undefined;
  }

  async getDraft(id: string): Promise<DistillDraft | undefined> {
    const row = await this.db.get<DraftRow>("SELECT * FROM distill_drafts WHERE id = ?", [id]);
    return row ? mapDraft(row) : undefined;
  }

  async upsertDraft(draft: DistillDraft): Promise<void> {
    await this.db.run(
      `INSERT INTO distill_drafts (
         id, scope_kind, scope_id, title, body, source_ids, source_fingerprints,
         expected_rev, provider, model, status, stale_reason, error, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, body = excluded.body,
         source_ids = excluded.source_ids, source_fingerprints = excluded.source_fingerprints,
         expected_rev = excluded.expected_rev, provider = excluded.provider, model = excluded.model,
         status = excluded.status, stale_reason = excluded.stale_reason, error = excluded.error,
         attempts = excluded.attempts, updated_at = excluded.updated_at`,
      [
        draft.id,
        draft.scopeKind,
        draft.scopeId,
        draft.title,
        draft.body,
        draft.sourceIds.join("\u001f"),
        draft.sourceFingerprints.join("\u001f"),
        draft.expectedRev,
        draft.provider,
        draft.model,
        draft.status,
        draft.staleReason,
        draft.error,
        draft.attempts,
        draft.createdAt,
        draft.updatedAt,
      ],
    );
  }
}
