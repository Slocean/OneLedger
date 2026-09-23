/** 真实规模检索性能：5000 篇正式记忆，三字以上 trigram 与两字 LIKE 分别测量。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { openDb } from "../src/db/driver.js";
import { MemoryService } from "../src/memory/service.js";
import { Store } from "../src/memory/store.js";

const dir = mkdtempSync(join(tmpdir(), "oneledger-perf-"));
const config = defaultConfig();
config.storage.sqlitePath = join(dir, "perf.db");
const db = await openDb(config);
const store = new Store(db);
const service = new MemoryService(store, config);

const now = new Date().toISOString();
const N = 5000;
await db.transaction(async (tx) => {
  for (let i = 0; i < N; i += 1) {
    await tx.run(
      `INSERT INTO memories (id, rev, title, body, scope_kind, scope_id, sensitivity, status, source, origin_node, content_hash, created_at, updated_at, forgotten_at, superseded_by)
       VALUES (?, 1, ?, ?, 'project', ?, 'public', 'active', 'mcp:perf', 'perf', ?, ?, ?, NULL, NULL)`,
      [`mem_${i}`, `项目说明 ${i}`, `第 ${i} 篇记忆：采集器读取约定文件，蒸馏后覆盖整篇。编号 ${i} 用于检索评测。`, `repo-${i % 200}`, `hash_${i}`, now, now],
    );
  }
});

const cases: Array<[string, string]> = [
  ["约定文件", "trigram 三字以上中文"],
  ["蒸馏后覆盖", "trigram 五字中文"],
  ["编号 4999", "trigram 中文+数字"],
  ["约定", "LIKE 两字短词"],
  ["记忆", "LIKE 两字短词（高频）"],
];
for (const [query, label] of cases) {
  const runs: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    const rows = await service.search(query, "perf", 8);
    runs.push(performance.now() - started);
    if (i === 0) console.log(`${label} 「${query}」 首次返回 ${rows.length} 条，首条=${rows[0]?.id ?? "-"}`);
  }
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  console.log(`${label} 「${query}」 5 次平均 ${avg.toFixed(1)}ms 最大 ${Math.max(...runs).toFixed(1)}ms`);
}

await db.close();
rmSync(dir, { recursive: true, force: true });
