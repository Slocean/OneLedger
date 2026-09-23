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

export class Store {
  constructor(private readonly db: Db) {}

  async transaction<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((db) => work(new Store(db)));
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
      `INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ],
    );
    return row;
  }

  async getInbox(id: string): Promise<InboxRecord | undefined> {
    const row = await this.db.get<InboxRow>("SELECT * FROM inbox WHERE id = ?", [id]);
    return row ? mapInbox(row) : undefined;
  }

  async findCollectedInbox(source: string, scopeKind: InboxRecord["scopeKind"], scopeId: string, body: string): Promise<InboxRecord | undefined> {
    const row = await this.db.get<InboxRow>(
      "SELECT * FROM inbox WHERE source = ? AND scope_kind = ? AND scope_id = ? AND substr(body, 1, 128) = substr(?, 1, 128) AND body = ? LIMIT 1",
      [source, scopeKind, scopeId, body, body],
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

  /** 按作用域聚合待蒸馏材料：计数与最旧/最新时间在一次查询内完成。 */
  async inboxScopeSummary(): Promise<Array<{ scopeKind: string; scopeId: string; pending: number; highSignal: number; oldestAt?: string }>> {
    const rows = await this.db.all<{ scope_kind: string; scope_id: string; pending: number; high_signal: number; oldest_at: string | null }>(
      `SELECT scope_kind, scope_id,
              COUNT(*) AS pending,
              SUM(CASE WHEN lower(source) LIKE '%workbuddy%' THEN 1 ELSE 0 END) AS high_signal,
              MIN(created_at) AS oldest_at,
              MAX(created_at) AS newest_at
       FROM inbox WHERE queue_status = 'proposed'
       GROUP BY scope_kind, scope_id
       ORDER BY high_signal DESC, newest_at DESC`,
    );
    return rows.map((row) => ({
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      pending: Number(row.pending ?? 0),
      highSignal: Number(row.high_signal ?? 0),
      oldestAt: row.oldest_at ?? undefined,
    }));
  }

  /** 一次取出全部作用域的材料样本（每作用域最多 limit 条），避免逐作用域查询。 */
  async inboxSamplesByScope(limit = 40): Promise<InboxRecord[]> {
    const rows = await this.db.all<InboxRow>(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY scope_kind, scope_id
           ORDER BY CASE WHEN lower(source) LIKE '%workbuddy%' THEN 0 WHEN lower(source) LIKE '%project%' THEN 1 ELSE 2 END,
                    created_at DESC
         ) AS scope_rank
         FROM inbox WHERE queue_status = 'proposed'
       ) WHERE scope_rank <= ?`,
      [limit],
    );
    return rows.map(mapInbox);
  }

  /** 一次取回每个作用域的最新草稿。 */
  async allLatestDrafts(): Promise<Map<string, DistillDraft>> {
    const rows = await this.db.all<DraftRow>(
      `SELECT * FROM (
         SELECT distill_drafts.*,
                ROW_NUMBER() OVER (PARTITION BY scope_kind, scope_id ORDER BY updated_at DESC) AS scope_rank
         FROM distill_drafts
       ) WHERE scope_rank = 1`,
    );
    const out = new Map<string, DistillDraft>();
    for (const row of rows) {
      const draft = mapDraft(row);
      out.set(`${draft.scopeKind}\u0000${draft.scopeId}`, draft);
    }
    return out;
  }

  /** 仍待审核的草稿，供接口在返回任务前刷新过期状态。 */
  async pendingDrafts(): Promise<DistillDraft[]> {
    const rows = await this.db.all<DraftRow>("SELECT * FROM distill_drafts WHERE status = 'pending' ORDER BY updated_at DESC");
    return rows.map(mapDraft);
  }

  /** 某个作用域的材料样本，高信号优先、其次新的在前。 */
  async inboxScopeSample(scopeKind: string, scopeId: string, limit = 40): Promise<InboxRecord[]> {
    const rows = await this.db.all<InboxRow>(
      `SELECT * FROM inbox WHERE queue_status = 'proposed' AND scope_kind = ? AND scope_id = ?
       ORDER BY CASE WHEN lower(source) LIKE '%workbuddy%' THEN 0 WHEN lower(source) LIKE '%project%' THEN 1 ELSE 2 END,
                created_at DESC
       LIMIT ?`,
      [scopeKind, scopeId, limit],
    );
    return rows.map(mapInbox);
  }

  async inboxHitTypes(id: string): Promise<string[]> {
    const rows = await this.db.all<{ hit_type: string }>("SELECT DISTINCT hit_type FROM redaction_events WHERE inbox_id = ? ORDER BY hit_type", [id]);
    return rows.map((row) => row.hit_type);
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
       ORDER BY last_seen_at DESC LIMIT 1`,
      [collector, sourceKey, scopeKind, scopeId, rulesVersion],
    );
    return row ? { id: row.id, contentHash: row.content_hash, lastStatus: row.last_status } : undefined;
  }

  async touchFingerprint(id: string, lastStatus: string): Promise<void> {
    await this.db.run("UPDATE collect_fingerprints SET last_seen_at = ?, last_status = ? WHERE id = ?", [
      nowIso(),
      lastStatus,
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
    await this.db.run(
      `INSERT INTO collect_fingerprints
         (id, collector, source_key, scope_kind, scope_id, content_hash, rules_version, last_status, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (collector, source_key, scope_kind, scope_id, content_hash, rules_version)
       DO UPDATE SET last_seen_at = excluded.last_seen_at, last_status = excluded.last_status`,
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
