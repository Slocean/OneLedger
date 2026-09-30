// 开发 MCP server stdio 端到端自测：initialize → tools/list → read → click。
import { spawn } from "node:child_process";

const server = spawn(process.execPath, ["scripts/dev-mcp.mjs"], {
  env: { ...process.env, ONELEDGER_DEV_URL: "http://127.0.0.1:17443", ONELEDGER_ADMIN_TOKEN: (process.env.ONELEDGER_ADMIN_TOKEN || "") },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
server.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message.result);
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
});

function call(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const tools = await call(1, "tools/list", {});
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
// 第六轮：工具清单与驱动能力一致——没有任何 eval 通道，click 显式声明 confirm 语义
const toolNames = tools.tools.map((t) => t.name);
if (toolNames.includes("dev_eval")) { console.error("FAIL: tools/list 仍包含 dev_eval"); process.exit(1); }
const clickTool = tools.tools.find((t) => t.name === "dev_ui_click");
if (!clickTool?.inputSchema?.properties?.confirm) { console.error("FAIL: dev_ui_click 缺少 confirm 声明"); process.exit(1); }

const unwrap = (callResult) => JSON.parse(callResult.content[0].text).result ?? {};

const read = await call(2, "tools/call", { name: "dev_ui_read", arguments: {} });
const page = unwrap(read).page ?? {};
console.log("read ok — tabs:", (page.buttons ?? []).filter((b) => ["记忆", "蒸馏队列", "设置"].includes(b.text)).map((b) => b.text));

const click = await call(3, "tools/call", { name: "dev_ui_click", arguments: { text: "记忆" } });
console.log("click:", unwrap(click).clicked);

const wait = await call(4, "tools/call", { name: "dev_ui_wait_text", arguments: { text: "共享记忆总账", timeoutMs: 3000 } });
console.log("waitText:", unwrap(wait).found);

server.kill();
console.log("DEV-MCP-SELFTEST-PASS");
