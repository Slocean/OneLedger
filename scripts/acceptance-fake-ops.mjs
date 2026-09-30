// 注入 44 条假操作记录（仅用于操作列表分页验收）：20 条比真实操作新，24 条更旧。
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/bigse/AppData/Local/Temp/ol-acceptance/data/acceptance.db");
db.exec("DELETE FROM scope_merge_operations WHERE id LIKE 'sm_fake_%'");
const real = JSON.parse((await import("node:fs")).readFileSync("C:/Users/bigse/AppData/Local/Temp/ol-real-op.json", "utf8"));
const base = Date.parse(real.createdAt ?? new Date().toISOString());
const ins = db.prepare(
  `INSERT INTO scope_merge_operations (id, from_scope_kind, from_scope_id, to_scope_kind, to_scope_id, moved_ids, moved_count, source_breakdown, status, created_at, reverted_at)
   VALUES (?, 'project', ?, 'project', ?, '', ?, '{}', ?, ?, ?)
   ON CONFLICT(id) DO NOTHING`,
);
let n = 0;
// 20 条更新（页 1）：fake_new_01..20，时间在真实操作之后
for (let i = 1; i <= 20; i += 1) {
  ins.run(`sm_fake_new_${String(i).padStart(2, "0")}`, `fake_new_${String(i).padStart(2, "0")}`, "FakeTarget", i, "applied", new Date(base + i * 60_000).toISOString(), null);
  n += 1;
}
// 24 条更旧（页 2 其余 + 页 3）：fake_old_01..24
for (let i = 1; i <= 24; i += 1) {
  const status = i % 3 === 0 ? "reverted" : "applied";
  ins.run(`sm_fake_old_${String(i).padStart(2, "0")}`, `fake_old_${String(i).padStart(2, "0")}`, "FakeTarget", i, status, new Date(base - i * 60_000).toISOString(), status === "reverted" ? new Date(base - i * 60_000 + 30_000).toISOString() : null);
  n += 1;
}
console.log(`inserted ${n} fake operations`);
const total = db.prepare("SELECT COUNT(*) n FROM scope_merge_operations").get().n;
console.log("total operations:", total);
// 验证真实操作的位次（created_at DESC）：应有 20 条比它新 → 页 2 首行
const rank = db.prepare("SELECT COUNT(*) + 1 AS rank FROM scope_merge_operations WHERE created_at > (SELECT created_at FROM scope_merge_operations WHERE id = ?)").get(real.operationId);
console.log("real op rank (1-based):", rank.rank);
db.close();
