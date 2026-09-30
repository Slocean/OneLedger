// 隔离库注入：3 页选择材料（44+1 条）、3000 条批次作用域、tiny 归并来源、44 条假操作记录。
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/bigse/AppData/Local/Temp/ol-acceptance/data/acceptance.db");
const now = new Date().toISOString();
const ins = db.prepare(
  "INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids) VALUES (?, ?, ?, 'cursor', 'project', ?, 'public', 0, ?, 'proposed', '')",
);

const pluginScope = "skills" + String.fromCharCode(92) + "system" + String.fromCharCode(92) + "plugin";
let n = 0;
for (let i = 100; i < 120; i += 1) {
  const body = `三页选择材料 ${i}：内容足够长以通过最短限制要求。`;
  ins.run(`in_acc${i}`, `三页材料 ${i}`, body, pluginScope, now);
  n += 1;
}
for (let i = 1; i <= 3000; i += 1) {
  const body = `批次归并材料 ${i}：内容足够长以通过最短限制要求，用于窗口批次验收。`;
  ins.run(`in_batch${String(i).padStart(5, "0")}`, `批次材料 ${i}`, body, "batch_scope", now);
  n += 1;
}
for (let i = 1; i <= 2; i += 1) {
  const body = `真实归并来源材料 ${i}：内容足够长以通过最短限制要求。`;
  ins.run(`in_tiny${i}`, `真实归并来源 ${i}`, body, "tiny" + String.fromCharCode(92) + "merge", now);
  n += 1;
}
console.log(`inserted ${n} inbox rows`);

// 44 条假操作记录：真实操作先建，created_at 介于两段假记录之间（修复轮窗口步骤再插入假记录）
console.log("plugin scope now:", db.prepare("SELECT COUNT(*) n FROM inbox WHERE scope_id = ? AND queue_status='proposed'").get(pluginScope).n);
console.log("batch scope:", db.prepare("SELECT COUNT(*) n FROM inbox WHERE scope_id='batch_scope'").get().n);
db.close();
