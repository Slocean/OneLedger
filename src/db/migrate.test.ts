import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import { openDb } from "./driver.js";

describe("db migrations", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function configIn(dir: string) {
    const config = defaultConfig();
    config.storage.sqlitePath = join(dir, "test.db");
    return config;
  }

  /** P1-07：已有 v10 库升级到 v11 时，moved_ids 文本一次性回填进 item 表，原字段保留。 */
  it("upgrade from v10 backfills scope_merge_operation_items and keeps moved_ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-migrate-"));
    dirs.push(dir);
    const config = configIn(dir);
    const db = await openDb(config);
    await db.close();

    // 把库回退到 v10 形态：删 v11 标记与 item 表，塞一条旧 moved_ids 记录
    const raw = new DatabaseSync(config.storage.sqlitePath);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 11");
    raw.exec("DROP TABLE scope_merge_operation_items");
    raw.exec(
      `INSERT INTO scope_merge_operations (id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_ids, moved_count, source_breakdown, status, created_at)
       VALUES ('sm_legacy', 'project', 'badpath', 'project', 'Target', 'in_a\u001fin_b\u001fin_c', 3, '{}', 'applied', 'now')`,
    );
    raw.close();

    const reopened = await openDb(config);
    const items = await reopened.all<{ inbox_id: string }>(
      "SELECT inbox_id FROM scope_merge_operation_items WHERE operation_id = 'sm_legacy' ORDER BY inbox_id",
    );
    expect(items.map((row) => row.inbox_id)).toEqual(["in_a", "in_b", "in_c"]);
    const moved = await reopened.get<{ moved_ids: string }>("SELECT moved_ids FROM scope_merge_operations WHERE id = 'sm_legacy'");
    expect(moved?.moved_ids ?? "").toContain("in_a");
    const marker = await reopened.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 11");
    expect(Number(marker?.n ?? 0)).toBe(1);
    await reopened.close();
  });

  /** P1-07：v11 库重复打开（重启）幂等，不重复回填、不重复写标记。 */
  it("reopen at v11 is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-migrate-"));
    dirs.push(dir);
    const config = configIn(dir);
    const first = await openDb(config);
    await first.close();
    const second = await openDb(config);
    const markers = await second.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations WHERE version BETWEEN 1 AND 11");
    expect(Number(markers?.n ?? 0)).toBe(11);
    const items = await second.get<{ n: number }>("SELECT COUNT(*) AS n FROM scope_merge_operation_items");
    expect(Number(items?.n ?? 0)).toBe(0);
    await second.close();
  });

  /** P1-07：缺核心表时启动必须显式失败，不能带病运行。 */
  it("missing required table fails loudly on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-migrate-"));
    dirs.push(dir);
    const config = configIn(dir);
    const db = await openDb(config);
    await db.close();
    const raw = new DatabaseSync(config.storage.sqlitePath);
    raw.exec("DROP TABLE scope_merge_operation_items");
    raw.close();
    await expect(openDb(config)).rejects.toThrow();
  });

  /** B-11：schema 比程序高 1 的库，打开前即拒绝，且任何写入都被挡住。 */
  it("rejects a database with a newer schema before running any migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-migrate-"));
    dirs.push(dir);
    const config = configIn(dir);
    const db = await openDb(config);
    await db.close();
    const raw = new DatabaseSync(config.storage.sqlitePath);
    raw.exec(
      `INSERT INTO schema_migrations (version, applied_at) VALUES (${12 + 1}, 'now')`,
    );
    raw.close();
    await expect(openDb(config)).rejects.toThrow(/比当前程序支持/);
    // 迁移标记未被本程序改动（没有继续写库）：仍是打开前的 13 条（v1..v12 + 注入的 v13）
    const check = new DatabaseSync(config.storage.sqlitePath, { readOnly: true });
    const markers = check.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(Number(markers.n)).toBe(13);
    check.close();
  });

  /** 第五轮修复：版本只读检查必须先于一切可写 PRAGMA——拒绝未来 schema 库时零写入：
   *  文件 hash 不变、journal 模式保持 delete（不被改成 wal）、行数据原样、句柄已释放。 */
  it("rejecting a newer-schema database performs zero writes (hash, journal mode, data, handle)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-migrate-"));
    dirs.push(dir);
    const dbPath = join(dir, "future.db");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    seed.exec("INSERT INTO schema_migrations VALUES (13, 'synthetic')");
    seed.exec("CREATE TABLE keepsake (note TEXT NOT NULL)");
    seed.exec("INSERT INTO keepsake VALUES ('迁移前数据必须原样保留')");
    seed.exec("PRAGMA journal_mode = DELETE");
    seed.close();
    const { createHash } = await import("node:crypto");
    const hashOf = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = hashOf();
    const config = configIn(dir);
    config.storage.sqlitePath = dbPath;
    await expect(openDb(config)).rejects.toThrow(/比当前程序支持/);
    expect(hashOf()).toBe(before);
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    const journal = probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("delete");
    const keepsake = probe.prepare("SELECT note FROM keepsake").get() as { note: string };
    expect(keepsake.note).toContain("原样保留");
    probe.close();
    // 句柄已释放：库文件可被重命名（Windows 上句柄未释放时重命名会失败）
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
    renameSync(`${dbPath}.moved`, dbPath);
  });

  /** 第五轮残余缺口：schema 检查本身抛异常（库文件损坏）时，openDb 也必须先关句柄再抛。 */
  it("releases the handle when the schema check itself fails on a corrupt database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-migrate-"));
    dirs.push(dir);
    const dbPath = join(dir, "corrupt.db");
    // 有合法 SQLite 头但页数据全空：连接可打开，首个 schema 查询会失败
    const header = Buffer.alloc(4096, 0);
    Buffer.from("SQLite format 3\0", "ascii").copy(header, 0);
    writeFileSync(dbPath, header);
    const config = configIn(dir);
    config.storage.sqlitePath = dbPath;
    await expect(openDb(config)).rejects.toThrow();
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
    renameSync(`${dbPath}.moved`, dbPath);
  });

  /** 第六轮修复：schema_migrations 表存在但结构损坏（缺 version 列）时，
   *  版本检查 SQL 抛错必须同样失败关闭：先释放句柄、零写入（hash/journal/数据原样）。 */
  it("releases the handle and performs zero writes when schema_migrations lacks a version column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oneledger-migrate-"));
    dirs.push(dir);
    const dbPath = join(dir, "malformed.db");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE schema_migrations (foo TEXT NOT NULL)");
    seed.exec("CREATE TABLE keepsake (note TEXT NOT NULL)");
    seed.exec("INSERT INTO keepsake VALUES ('迁移前数据必须原样保留')");
    seed.exec("PRAGMA journal_mode = DELETE");
    seed.close();
    const { createHash } = await import("node:crypto");
    const hashOf = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const before = hashOf();
    const config = configIn(dir);
    config.storage.sqlitePath = dbPath;
    await expect(openDb(config)).rejects.toThrow(/version|schema/);
    expect(hashOf()).toBe(before);
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    const journal = probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(journal.journal_mode).toBe("delete");
    const keepsake = probe.prepare("SELECT note FROM keepsake").get() as { note: string };
    expect(keepsake.note).toContain("原样保留");
    probe.close();
    // 句柄已释放：库文件可被重命名（Windows 上句柄未释放时重命名会失败）
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
    renameSync(`${dbPath}.moved`, dbPath);
  });

  /** B-09：选择 PostgreSQL 时在连接/发任何 SQL 之前明确拒绝。 */
  it("fails fast with an actionable error before touching any database when postgres is selected", async () => {
    const config = defaultConfig();
    config.storage.driver = "postgres";
    config.storage.postgresUrl = "postgres://user:pass@127.0.0.1:5432/oneledger";
    await expect(openDb(config)).rejects.toThrow(/只支持 SQLite/);
  });
});
