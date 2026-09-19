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
  constructor(private readonly db: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...asSqlValues(params));
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...asSqlValues(params)) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...asSqlValues(params)) as T | undefined;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDb implements Db {
  readonly driver = "postgres" as const;
  constructor(private readonly pool: pg.Pool) {}

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.query(toPostgres(sql), params);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(toPostgres(sql), params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.pool.query(toPostgres(sql), params);
    return result.rows[0] as T | undefined;
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
  if (current < DATA_SCHEMA_VERSION) {
    throw new Error(`Database is behind schema ${DATA_SCHEMA_VERSION}; update OneLedger.`);
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
