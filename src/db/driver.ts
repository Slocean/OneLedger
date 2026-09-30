import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AppConfig } from "../types.js";
import { DATA_SCHEMA_VERSION } from "../types.js";
import { INIT_SQL } from "./sql.js";

export interface Db {
  driver: "sqlite" | "postgres";
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<number>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  transaction<T>(work: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function asSqlValues(params: unknown[]): SQLInputValue[] {
  return params.map((value) => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
      return value;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value instanceof Uint8Array) return value;
    return String(value);
  });
}

class SqliteDb implements Db {
  readonly driver = "sqlite" as const;
  private gate: Promise<void> = Promise.resolve();
  constructor(private readonly db: DatabaseSync, private readonly direct = false) {}

  private async locked<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.direct) return work();
    const previous = this.gate;
    let release: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.locked(() => this.db.exec(sql));
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    return this.locked(() => {
      const result = this.db.prepare(sql).run(...asSqlValues(params));
      return Number(result.changes ?? 0);
    });
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.locked(() => this.db.prepare(sql).all(...asSqlValues(params)) as T[]);
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.locked(() => this.db.prepare(sql).get(...asSqlValues(params)) as T | undefined);
  }

  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {
    if (this.direct) return work(this);
    return this.locked(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(new SqliteDb(this.db, true));
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    if (!this.direct) await this.locked(() => this.db.close());
  }
}

export async function openDb(config: AppConfig): Promise<Db> {
  if (config.storage.driver === "postgres") {
    // B-09：本期产品边界是 SQLite。在连接、发任何 SQL 之前就明确拒绝，
    // 不让用户在 PG 模式下撞上 SQLite 方言的随机语法错误或空队列。
    throw new Error(
      "OneLedger 本期只支持 SQLite 存储；PostgreSQL 支持尚未交付。请在设置中把存储改回「本机 SQLite」。",
    );
  }
  mkdirSync(dirname(config.storage.sqlitePath), { recursive: true });
  const sqlite = new DatabaseSync(config.storage.sqlitePath);
  // B-11 + 第五轮修复：schema 版本检查是纯只读，必须先于一切可写 PRAGMA
  // （journal_mode=WAL 会改库文件头）与 DDL/迁移执行——拒绝打开未来 schema 库时零写入：
  // 文件 hash、journal 模式与行数据全部保持原样。
  // 失败关闭：schema 检查、PRAGMA、迁移任何一步抛错（含库文件损坏导致的 SQL 异常）
  // 都必须先释放文件句柄（否则 Windows 上库文件保持锁定），再向上传播。
  try {
    const newer = await sqliteSchemaNewerThanSupported(sqlite);
    if (newer) {
      throw new Error(
        `数据库 schema ${newer} 比当前程序支持的 ${DATA_SCHEMA_VERSION} 新：请先升级 OneLedger，` +
          "不要用旧程序打开新库（回退请恢复与旧版本匹配的完整备份）",
      );
    }
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const db = new SqliteDb(sqlite);
    await migrate(db);
    return db;
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // 句柄可能已由内层关闭；释放失败不掩盖原始错误
    }
    throw error;
  }
}

/** 已存在的库若 schema 版本高于本程序支持值，返回其版本号；全新库（无迁移表）返回 undefined。 */
async function sqliteSchemaNewerThanSupported(sqlite: DatabaseSync): Promise<number | undefined> {
  const table = sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { n: number } | undefined;
  if (!table || Number(table.n ?? 0) === 0) return undefined;
  const row = sqlite.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number } | undefined;
  const current = Number(row?.version ?? 0);
  return current > DATA_SCHEMA_VERSION ? current : undefined;
}

async function migrate(db: Db): Promise<void> {
  await db.exec(INIT_SQL);
  const row = await db.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
  let current = Number(row?.version ?? 0);
  if (current < 1) {
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [1, new Date().toISOString()]);
    current = 1;
  }
  if (current < 2) {
    await addColumn(db, "inbox", "queue_status", "TEXT NOT NULL DEFAULT 'proposed'");
    await addColumn(db, "inbox", "conflict_ids", "TEXT NOT NULL DEFAULT ''");
    await addColumn(db, "memories", "superseded_by", "TEXT");
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [2, new Date().toISOString()]);
    current = 2;
  }
  if (current < 3) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        builtin INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        root_path TEXT NOT NULL,
        last_scanned_at TEXT,
        last_scanned_files INTEGER NOT NULL DEFAULT 0,
        last_ingested INTEGER NOT NULL DEFAULT 0,
        last_queued INTEGER NOT NULL DEFAULT 0,
        last_redacted INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
    `);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [3, new Date().toISOString()]);
    current = 3;
  }
  if (current < 4) {
    if (db.driver === "sqlite") {
      await db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, content='memories', content_rowid='rowid', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
          INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
        INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
      `);
    }
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [4, new Date().toISOString()]);
    current = 4;
  }
  if (current < 5) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS collect_fingerprints (
        id TEXT PRIMARY KEY,
        collector TEXT NOT NULL,
        source_key TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        rules_version INTEGER NOT NULL,
        last_status TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (collector, source_key, scope_kind, scope_id, content_hash, rules_version)
      );
      CREATE INDEX IF NOT EXISTS collect_fp_latest
        ON collect_fingerprints(collector, source_key, scope_kind, scope_id, rules_version, last_seen_at);
    `);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [5, new Date().toISOString()]);
    current = 5;
  }
  if (current < 6) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS distill_drafts (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        source_fingerprints TEXT NOT NULL,
        expected_rev INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        stale_reason TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS distill_drafts_scope
        ON distill_drafts(scope_kind, scope_id, status, updated_at);
    `);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [6, new Date().toISOString()]);
    current = 6;
  }
  if (current < 7) {
    await db.transaction(async (tx) => {
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS vault_items (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          scope_kind TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          protected_value ${tx.driver === "postgres" ? "BYTEA" : "BLOB"} NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS vault_items_scope
          ON vault_items(scope_kind, scope_id, updated_at);
      `);
      await tx.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [7, new Date().toISOString()]);
    });
    current = 7;
  }
  if (current < 8) {
    await addColumn(db, "api_keys", "protected_token", "BLOB");
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [8, new Date().toISOString()]);
    current = 8;
  }
  if (current < 9) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS trusted_mcp_sources (
        key_id TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (key_id, source)
      );
    `);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [9, new Date().toISOString()]);
    current = 9;
  }
  if (current < 10) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS scope_merge_operations (
        id TEXT PRIMARY KEY,
        from_scope_kind TEXT NOT NULL,
        from_scope_id TEXT NOT NULL,
        to_scope_kind TEXT NOT NULL,
        to_scope_id TEXT NOT NULL,
        moved_ids TEXT NOT NULL,
        moved_count INTEGER NOT NULL,
        source_breakdown TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reverted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS scope_merge_ops_status ON scope_merge_operations(status, created_at);
    `);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [10, new Date().toISOString()]);
    current = 10;
  }
  if (current < 11) {
    // v11：归并批次精确 ID 改存 scope_merge_operation_items 主键表，
    // 旧 v10 的 moved_ids 文本一次性回填进 item 表；原字段保留到兼容期结束。
    await db.exec(`
      CREATE TABLE IF NOT EXISTS scope_merge_operation_items (
        operation_id TEXT NOT NULL,
        inbox_id TEXT NOT NULL,
        PRIMARY KEY (operation_id, inbox_id)
      );
    `);
    const legacy = await db.all<{ id: string; moved_ids: string }>(
      "SELECT id, moved_ids FROM scope_merge_operations WHERE moved_ids != ''",
    );
    for (const row of legacy) {
      for (const inboxId of (row.moved_ids ?? "").split("\u001f").filter(Boolean)) {
        await db.run("INSERT OR IGNORE INTO scope_merge_operation_items (operation_id, inbox_id) VALUES (?, ?)", [row.id, inboxId]);
      }
    }
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [11, new Date().toISOString()]);
    current = 11;
  }
  if (current < 12) {
    // v12：B-05 给 inbox 加稳定来源键；C-02 给采集指纹加单调 touched_seq。
    await addColumn(db, "inbox", "source_key", "TEXT NOT NULL DEFAULT ''");
    await addColumn(db, "collect_fingerprints", "touched_seq", "INTEGER NOT NULL DEFAULT 0");
    await db.run("UPDATE collect_fingerprints SET touched_seq = rowid WHERE touched_seq = 0");
    const maxSeq = await db.get<{ n: number }>("SELECT COALESCE(MAX(touched_seq), 0) AS n FROM collect_fingerprints");
    await db.run(
      "INSERT INTO sync_meta (key, value) VALUES ('fp_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(Number(maxSeq?.n ?? 0))],
    );
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [12, new Date().toISOString()]);
    current = 12;
  }
  if (current < DATA_SCHEMA_VERSION) {
    throw new Error(`Database is behind schema ${DATA_SCHEMA_VERSION}; update OneLedger.`);
  }
  if (current > DATA_SCHEMA_VERSION) {
    throw new Error(`数据库 schema ${current} 比当前程序支持的 ${DATA_SCHEMA_VERSION} 新：请先升级 OneLedger`);
  }
  await verifyRequiredTables(db);
  await verifyMergeOperationIntegrity(db);
  await db.exec(
    "CREATE INDEX IF NOT EXISTS inbox_status_created ON inbox(queue_status, created_at);" +
      "CREATE INDEX IF NOT EXISTS inbox_proposed_scope ON inbox(queue_status, scope_kind, scope_id, created_at);" +
      "CREATE INDEX IF NOT EXISTS redaction_events_inbox ON redaction_events(inbox_id);" +
      "CREATE INDEX IF NOT EXISTS inbox_source_key ON inbox(source, scope_kind, scope_id, source_key);" +
      "CREATE INDEX IF NOT EXISTS collect_fp_touched ON collect_fingerprints(collector, source_key, rules_version, touched_seq);",
  );
}

/** B-06：启动校验归并操作完整性——moved_count 与 distinct items 一致、无孤儿明细。 */
async function verifyMergeOperationIntegrity(db: Db): Promise<void> {
  const mismatch = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM scope_merge_operations o
     WHERE (o.moved_ids = '' AND (SELECT COUNT(DISTINCT s.inbox_id) FROM scope_merge_operation_items s WHERE s.operation_id = o.id) != o.moved_count)
        OR (o.moved_ids != '' AND EXISTS (SELECT 1 FROM scope_merge_operation_items s WHERE s.operation_id = o.id)
            AND (SELECT COUNT(DISTINCT s.inbox_id) FROM scope_merge_operation_items s WHERE s.operation_id = o.id) != o.moved_count)`,
  );
  if (Number(mismatch?.n ?? 0) > 0) {
    throw new Error("部分归并操作的 moved_count 与批次明细数不一致，数据库可能已损坏或导入不完整；请从备份恢复");
  }
  const orphans = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM scope_merge_operation_items s
     WHERE NOT EXISTS (SELECT 1 FROM scope_merge_operations o WHERE o.id = s.operation_id)`,
  );
  if (Number(orphans?.n ?? 0) > 0) {
    throw new Error("部分归并批次明细没有对应的操作记录（孤儿 item），数据库可能已损坏；请从备份恢复");
  }
}

/** 迁移完成后校验核心表齐全；缺表说明数据库损坏或不完整，启动即报错而不是运行中崩溃。 */
async function verifyRequiredTables(db: Db): Promise<void> {
  const REQUIRED = [
    "memories",
    "inbox",
    "api_keys",
    "audit_log",
    "redaction_events",
    "redaction_archive",
    "sync_meta",
    "collect_fingerprints",
    "distill_drafts",
    "agents",
    "scope_merge_operations",
    "scope_merge_operation_items",
  ];
  for (const table of REQUIRED) {
    const row =
      db.driver === "sqlite"
        ? await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
        : await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_name = ?", [table]);
    if (Number(row?.n ?? 0) === 0) {
      throw new Error(`数据库缺少必需的表 ${table}，可能已损坏或不完整；请从备份恢复`);
    }
  }
}

async function addColumn(db: Db, table: string, column: string, definition: string): Promise<void> {
  if (db.driver === "sqlite") {
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (cols.some((col) => col.name === column)) return;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return;
  }
  await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}
