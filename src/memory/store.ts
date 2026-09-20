import type { Db } from "../db/driver.js";
import type { AgentRecord, ApiKeyRecord, InboxRecord, MemoryRecord, QueueStatus, ScopeFilter } from "../types.js";
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

  async listInbox(limit = 20_000, status: QueueStatus = "proposed"): Promise<InboxRecord[]> {
    const rows = await this.db.all<InboxRow>(
      "SELECT * FROM inbox WHERE queue_status = ? ORDER BY created_at DESC LIMIT ?",
      [status, limit],
    );
    return rows.map(mapInbox);
  }

  async rejectInbox(id: string): Promise<void> {
    await this.db.run("UPDATE inbox SET queue_status = 'rejected' WHERE id = ?", [id]);
  }

  async deleteInbox(id: string): Promise<void> {
    await this.db.run("DELETE FROM inbox WHERE id = ?", [id]);
  }

  async findActiveByHash(hash: string): Promise<MemoryRecord | undefined> {
    const row = await this.db.get<MemoryRow>(
      "SELECT * FROM memories WHERE content_hash = ? AND status = 'active' LIMIT 1",
      [hash],
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

  async setSyncCursor(value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_meta (key, value) VALUES ('cursor', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [value],
    );
  }
}
