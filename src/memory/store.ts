import type { Db } from "../db/driver.js";
import type { ApiKeyRecord, InboxRecord, MemoryRecord } from "../types.js";
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

interface InboxRow {
  id: string;
  title: string;
  body: string;
  source: string;
  scope_kind: InboxRecord["scopeKind"];
  scope_id: string;
  sensitivity: InboxRecord["sensitivity"];
  redacted: number;
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
    createdAt: row.created_at,
  };
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
      `INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ],
    );
    return row;
  }

  async listInbox(limit = 50): Promise<InboxRecord[]> {
    const rows = await this.db.all<InboxRow>(
      "SELECT * FROM inbox ORDER BY created_at DESC LIMIT ?",
      [limit],
    );
    return rows.map(mapInbox);
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

  async upsertMemory(record: MemoryRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO memories (
         id, rev, title, body, scope_kind, scope_id, sensitivity, status, source,
         origin_node, content_hash, created_at, updated_at, forgotten_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         forgotten_at = excluded.forgotten_at`,
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
      ],
    );
  }

  async getMemory(id: string): Promise<MemoryRecord | undefined> {
    const row = await this.db.get<MemoryRow>("SELECT * FROM memories WHERE id = ?", [id]);
    return row ? mapMemory(row) : undefined;
  }

  async listMemories(limit = 100): Promise<MemoryRecord[]> {
    const rows = await this.db.all<MemoryRow>(
      "SELECT * FROM memories WHERE status != 'forgotten' ORDER BY updated_at DESC LIMIT ?",
      [limit],
    );
    return rows.map(mapMemory);
  }

  async searchMemories(query: string, limit = 8): Promise<MemoryRecord[]> {
    const needle = `%${query.replaceAll("%", "")}%`;
    const rows = await this.db.all<MemoryRow>(
      `SELECT * FROM memories
       WHERE status = 'active' AND sensitivity != 'secret'
         AND (title LIKE ? OR body LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
      [needle, needle, limit],
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
    const inbox = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbox");
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

  async setSyncCursor(value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_meta (key, value) VALUES ('cursor', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [value],
    );
  }
}
