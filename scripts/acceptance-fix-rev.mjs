// 向 skills\system\plugin 作用域写入 rev 基准记忆（P0-02 冲突验收准备）。
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("C:/Users/bigse/AppData/Local/Temp/ol-acceptance/data/acceptance.db");
const scopeId = "skills" + String.fromCharCode(92) + "system" + String.fromCharCode(92) + "plugin";
const rows = db.prepare("SELECT id, scope_id FROM memories WHERE status='active'").all();
console.log("before:", JSON.stringify(rows));
// 清掉 heredoc 事故写入的错误作用域记忆，再按正确作用域写入 rev 1
db.prepare("DELETE FROM memories WHERE scope_id = 'skillssystemplugin'").run();
const body = "另一个人刚写入的版本：这是服务器上最新的整篇内容。";
const now = new Date().toISOString();
db.prepare(
  "INSERT INTO memories (id, rev, title, body, scope_kind, scope_id, sensitivity, status, source, origin_node, content_hash, created_at, updated_at) VALUES (?, 1, ?, ?, 'project', ?, 'public', 'active', 'ui', 'local', ?, ?, ?)",
).run("mem_conflict_rev1", "另一个人刚写入的版本", body, scopeId, "hash_conflict_rev1", now, now);
console.log("after:", JSON.stringify(db.prepare("SELECT id, scope_id, rev FROM memories WHERE status='active'").all()));
db.close();
