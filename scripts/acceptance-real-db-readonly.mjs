// 真实库只读统计：绝不写入。验证 OneLedger 作用域材料可分页访问。
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const dbPath = join(homedir(), ".oneledger", "data", "oneledger.db");
const db = new DatabaseSync(dbPath, { readOnly: true });
const scalar = (sql) => db.prepare(sql).get();
console.log("schema version:", scalar("SELECT MAX(version) v FROM schema_migrations").v);
console.log("active memories:", scalar("SELECT COUNT(*) n FROM memories WHERE status='active'").n);
console.log("proposed inbox:", scalar("SELECT COUNT(*) n FROM inbox WHERE queue_status='proposed'").n);
console.log("project:OneLedger inbox:", scalar("SELECT COUNT(*) n FROM inbox WHERE queue_status='proposed' AND scope_kind='project' AND scope_id='OneLedger'").n);
console.log("scopes:", scalar("SELECT COUNT(DISTINCT scope_id) n FROM inbox WHERE queue_status='proposed'").n);
console.log("merge operations:", scalar("SELECT COUNT(*) n FROM scope_merge_operations").n);
console.log("operation items:", scalar("SELECT COUNT(*) n FROM scope_merge_operation_items").n);
// 分页访问演练（只读）：OneLedger 作用域前 20 条按 created_at DESC
const page = db.prepare("SELECT id, title, created_at FROM inbox WHERE queue_status='proposed' AND scope_kind='project' AND scope_id='OneLedger' ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 0").all();
console.log("OneLedger page1 rows:", page.length, "| first:", page[0]?.title?.slice(0, 30));
db.close();
console.log("REAL-DB-READONLY-OK");
