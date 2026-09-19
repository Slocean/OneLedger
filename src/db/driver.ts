import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import pg from "pg";
import type { AppConfig } from "../types.js";
import { DATA_SCHEMA_VERSION } from "../types.js";
import { MIGRATIONS } from "./sql.js";

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
  await db.exec(MIGRATIONS[0]);
  const row = await db.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
  const current = row?.version ?? 0;
  if (current < DATA_SCHEMA_VERSION) {
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      DATA_SCHEMA_VERSION,
      new Date().toISOString(),
    ]);
  }
}
