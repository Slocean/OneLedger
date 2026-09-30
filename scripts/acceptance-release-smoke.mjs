#!/usr/bin/env node
// 发布冒烟：用打好的 release/OneLedger-Portable.exe + 隔离 HOME + 独立端口（17460）
// 验证 /api/health、/api/version、Agent MCP initialize 与 memory.get。
// 采集全关、devUi=false、admin token 随机生成只落隔离 config；结束后关闭进程并清理目录。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const home = join(process.cwd(), ".governance-test", `rel-smoke-${Date.now()}`);
mkdirSync(join(home, "data"), { recursive: true });
const adminToken = `ol_${randomBytes(24).toString("hex")}`;
const config = {
  schemaVersion: 1,
  bind: "127.0.0.1",
  port: 17460,
  storage: { driver: "sqlite", sqlitePath: join(home, "data", "smoke.db"), postgresUrl: "" },
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
  devUi: false,
};
writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));

const child = spawn(join(process.cwd(), "release", "OneLedger-Portable.exe"), [], {
  env: { ...process.env, ONELEDGER_HOME: home },
  stdio: "ignore",
});
const fail = async (msg) => {
  console.error("RELEASE-SMOKE-FAIL:", msg);
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 800 });
  } catch {
    console.log("cleanup-deferred: 隔离目录句柄稍后自动释放");
  }
  process.exit(1);
};
try {
  const base = "http://127.0.0.1:17460";
  // 等待进程起来
  let health = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      health = await fetch(`${base}/api/health`).then((r) => r.json());
      if (health?.ok === true) break;
    } catch { /* 未就绪 */ }
  }
  if (health?.ok !== true) await fail(`health 未就绪：${JSON.stringify(health)}`);
  if (health?.version !== "0.4.14") await fail(`health 版本不是 0.4.14：${health?.version}`);

  const version = await fetch(`${base}/api/version`).then((r) => r.json());
  if (version?.version !== "0.4.14") await fail(`/api/version 不是 0.4.14：${version?.version}`);
  if (version?.dataSchema !== 12) await fail(`dataSchema 不是 12：${version?.dataSchema}`);

  // 签发 Agent 密钥并预置 127.0.0.1 为受信来源（等价窗口「记住此设备」）
  const { DatabaseSync } = await import("node:sqlite");
  const issued = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: { "x-admin-token": adminToken, "content-type": "application/json" },
    body: JSON.stringify({ name: "release-smoke" }),
  }).then((r) => r.json());
  if (!issued?.token) await fail(`签发密钥失败：${JSON.stringify(issued).slice(0, 120)}`);
  const db = new DatabaseSync(join(home, "data", "smoke.db"));
  db.prepare("INSERT OR IGNORE INTO trusted_mcp_sources (key_id, source, created_at) VALUES (?, ?, ?)")
    .run(issued.id, "127.0.0.1", new Date().toISOString());
  db.close();

  const mcp = async (payload) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());

  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "release-smoke", version: "0" } } });
  if (init.result?.serverInfo?.name !== "oneledger" || init.result?.serverInfo?.version !== "0.4.14") {
    await fail(`MCP initialize 异常：${JSON.stringify(init).slice(0, 200)}`);
  }
  const get = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory.get", arguments: { scopeKind: "project", scopeId: "OneLedger" } } });
  const parsed = JSON.parse(get.result?.content?.[0]?.text ?? "null");
  if (!Array.isArray(parsed) || parsed.length !== 0) await fail(`memory.get(project, OneLedger) 应为空数组：${JSON.stringify(parsed).slice(0, 120)}`);

  child.kill();
  // WebView2 子进程退出稍慢：等句柄释放后尽力清理；清理失败不影响冒烟结论
  await new Promise((r) => setTimeout(r, 2000));
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 800 });
  } catch {
    console.log("cleanup-deferred: 隔离目录句柄稍后自动释放，不影响验证结果");
  }
  console.log("RELEASE-SMOKE-PASS");
  process.exit(0);
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
}
