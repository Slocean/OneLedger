import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import pg from "pg";
import type { AppConfig } from "../types.js";
import { DATA_SCHEMA_VERSION } from "../types.js";
import { INIT_SQL } from "./sql.js";

export interface Db {
  driver: "sqlite" | "postgres";
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
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

function toPostgres(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
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

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.locked(() => { this.db.prepare(sql).run(...asSqlValues(params)); });
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

class PostgresDb implements Db {
  readonly driver = "postgres" as const;
  constructor(private readonly pool: pg.Pool, private readonly client?: pg.PoolClient) {}

  async exec(sql: string): Promise<void> {
    await (this.client ?? this.pool).query(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await (this.client ?? this.pool).query(toPostgres(sql), params);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await (this.client ?? this.pool).query(toPostgres(sql), params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await (this.client ?? this.pool).query(toPostgres(sql), params);
    return result.rows[0] as T | undefined;
  }

  async transaction<T>(work: (db: Db) => Promise<T>): Promise<T> {
    if (this.client) return work(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresDb(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function openDb(config: AppConfig): Promise<Db> {
  if (config.storage.driver === "postgres") {
    if (!config.storage.postgresUrl.trim()) {
      throw new Error("Postgres URL is empty. Set it in the settings UI.");
    }
    const db = new PostgresDb(new pg.Pool({ connectionString: config.storage.postgresUrl }));
    await migrate(db);
    return db;
  }
  mkdirSync(dirname(config.storage.sqlitePath), { recursive: true });
  const sqlite = new DatabaseSync(config.storage.sqlitePath);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = new SqliteDb(sqlite);
  await migrate(db);
  return db;
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
  if (current < DATA_SCHEMA_VERSION) {
    throw new Error(`Database is behind schema ${DATA_SCHEMA_VERSION}; update OneLedger.`);
  }
  await db.exec("CREATE INDEX IF NOT EXISTS inbox_status_created ON inbox(queue_status, created_at)");
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
