// OneLedger 治理修复验收 — 隔离实例准备脚本
// 用法: ONELEDGER_HOME=<dir> node scripts/acceptance-setup.mjs
// 作用: 在隔离 HOME 下写 config.json，并向隔离库注入验收材料与待审草稿。
// B-08：admin token 每次随机生成，只写入隔离 config 与 <home>/admin-token.txt，
// 不落进仓库、日志或脚本源码；下游脚本通过 ONELEDGER_ADMIN_TOKEN 环境变量取得。
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const home = process.env.ONELEDGER_HOME;
if (!home) throw new Error("set ONELEDGER_HOME");
mkdirSync(join(home, "data"), { recursive: true });

const adminToken = `ol_${randomBytes(24).toString("hex")}`;
writeFileSync(join(home, "admin-token.txt"), `${adminToken}\n`, { mode: 0o600 });
const config = {
  schemaVersion: 1,
  bind: "127.0.0.1",
  port: Number(process.env.ONELEDGER_DEV_PORT || 17443),
  storage: { driver: "sqlite", sqlitePath: join(home, "data", "acceptance.db"), postgresUrl: "" },
  sync: { role: "local", remoteUrl: "", nodeKey: randomUUID(), intervalMin: 15 },
  collect: {
    cursor: false, claude: false, codex: false, continue: false,
    zcode: false, workbuddy: false, qoder: false, projects: false,
    intervalMin: 30, extraRoots: [],
  },
  distill: { provider: "none", baseUrl: "", model: "", apiKey: "" },
  security: { scanEnabled: true, allowInternalInSearch: false },
  updateUrl: "",
  adminToken,
  devUi: true,
};
writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));

const dbPath = join(home, "data", "acceptance.db");
if (!existsSync(dbPath)) {
  // 首次由应用建库迁移；这里只处理已存在的库（幂等注入）
  console.log(`config written; token at ${join(home, "admin-token.txt")}`);
  process.exit(0);
}
const db = new DatabaseSync(dbPath);
const now = new Date().toISOString();
const ins = db.prepare(
  "INSERT INTO inbox (id, title, body, source, scope_kind, scope_id, sensitivity, redacted, created_at, queue_status, conflict_ids) VALUES (?, ?, ?, ?, 'project', ?, 'public', 0, ?, 'proposed', '')",
);
let n = 0;
for (let i = 1; i <= 25; i += 1) {
  const body = `手工验收材料 ${i}：内容足够长以通过最短限制要求。`.repeat(2);
  ins.run(`in_acc${String(i).padStart(3, "0")}`, `验收材料 ${i}`, body, "cursor", "skills\\system\\plugin", now);
  n += 1;
}
// 路径型作用域一条
ins.run("in_acc_path", "归属待修正材料", "路径型作用域的验收材料，内容足够长以通过最短限制要求。", "cursor", "bad\\path", now);
// 正常作用域两条（rev 冲突场景用：草稿消费一条后，剩一条供手工冲突流程）
ins.run("in_acc_conflict", "冲突场景材料", "冲突场景的验收材料，内容足够长以通过最短限制要求。", "cursor", "ConflictScope", now);
ins.run("in_acc_conflict2", "冲突场景材料二", "冲突场景第二份验收材料，内容足够长以通过最短限制要求。", "cursor", "ConflictScope", now);
// 待审草稿（挂正常作用域）；B-03 要求指纹快照与来源一致，提交才可在事务内验证
const draft = db.prepare(
  "INSERT INTO distill_drafts (id, scope_kind, scope_id, title, body, source_ids, source_fingerprints, expected_rev, provider, model, status, stale_reason, error, attempts, created_at, updated_at) VALUES (?, 'project', ?, ?, ?, ?, ?, 0, 'stub', 'stub', 'pending', '', '', 1, ?, ?)",
);
const conflictInbox = db.prepare("SELECT id, title, body FROM inbox WHERE id = 'in_acc_conflict'").get();
const fingerprint = `${conflictInbox.id}:${createHash("sha256").update(`${conflictInbox.title}\n${conflictInbox.body}`).digest("hex")}`;
draft.run(
  "dd_acceptance",
  "ConflictScope",
  "草稿标题：冲突场景蒸馏",
  "草稿正文：未经审核的冲突场景蒸馏草稿。",
  conflictInbox.id,
  fingerprint,
  now,
  now,
);
db.close();
console.log(`seeded ${n + 2} inbox rows + 1 draft at ${dbPath}`);
console.log(`admin token written to ${join(home, "admin-token.txt")}（不落仓库/日志）`);
