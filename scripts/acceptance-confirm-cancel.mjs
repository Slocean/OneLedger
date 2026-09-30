#!/usr/bin/env node
// stdio MCP 确认/取消语义端到端测试（第六轮修复，B-08 后续）：
//   1. tools/list 不含 dev_eval，dev_ui_click 显式声明 confirm:boolean；
//   2. 取消（confirm 缺省=false）：原生 confirm 按取消处理，归并撤销不执行，操作保持已生效；
//   3. 同意（confirm:true）：只有显式同意才撤销，且只精确回移该批材料；
//   4. 普通点击前后 read 的 dialogPristine 恒为 true（confirm/alert 原函数保持，未被永久改写）。
// 需要一个已 seeding 的隔离 devui 实例：存在一条 applied 归并操作（其来源仍在目标作用域
// 待处理状态）。env：ONELEDGER_DEV_URL（默认 127.0.0.1:17443）、ONELEDGER_ADMIN_TOKEN。
import { spawn } from "node:child_process";

const server = spawn(process.execPath, ["scripts/dev-mcp.mjs"], {
  env: { ...process.env, ONELEDGER_DEV_URL: process.env.ONELEDGER_DEV_URL || "http://127.0.0.1:17443" },
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
      if (resolve) { pending.delete(message.id); resolve(message.result); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
function call(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
const unwrap = (r) => JSON.parse(r.content[0].text).result ?? {};
const fail = (msg) => { console.error("CONFIRM-CANCEL-FAIL:", msg); server.kill(); process.exit(1); };

// 1. 工具清单：无 eval、click 显式 confirm:boolean
const tools = await call(1, "tools/list", {});
const names = tools.tools.map((t) => t.name);
if (names.includes("dev_eval")) fail("tools/list 仍包含 dev_eval");
const clickTool = tools.tools.find((t) => t.name === "dev_ui_click");
if (!clickTool?.inputSchema?.properties?.confirm || clickTool.inputSchema.properties.confirm.type !== "boolean") {
  fail("dev_ui_click 缺少 confirm:boolean 声明");
}

// 2. read 基线：对话框原函数保持
const base = unwrap(await call(2, "tools/call", { name: "dev_ui_read", arguments: {} }));
if (base.page?.dialogPristine !== true) fail(`基线 dialogPristine=${base.page?.dialogPristine}`);
if (base.page?.nativeDialogsPresent !== true) fail("原生 confirm/alert 不存在？");

// 打开「归并操作记录」面板（按钮文字含「归并操作记录」）
const openPanel = unwrap(await call(3, "tools/call", { name: "dev_ui_click", arguments: { text: "归并操作记录" } }));
if (!openPanel.ok) fail(`打开归并操作记录失败：${openPanel.error}`);
const applied = unwrap(await call(4, "tools/call", { name: "dev_ui_wait_text", arguments: { text: "已生效", timeoutMs: 8000 } }));
if (!applied.ok) fail("没有找到已生效的归并操作（需要 seeding applied 操作）");
if (base.page?.dialogPristine !== true) fail("打开面板后 dialogPristine 不为 true");

// 3. 取消路径：缺省点击「撤销这次归并」→ confirm 返回 false → 撤销不执行
const cancelClick = unwrap(await call(5, "tools/call", { name: "dev_ui_click", arguments: { text: "撤销这次归并" } }));
if (!cancelClick.ok) fail(`取消路径点击失败：${cancelClick.error}`);
if (cancelClick.confirm !== false) fail("缺省点击 confirm 应为 false");
if (cancelClick.dialogPristine !== true) fail("取消点击后 confirm/alert 未恢复原实现");
// 操作记录仍显示已生效、未出现「已撤销」提示
const stillApplied = unwrap(await call(6, "tools/call", { name: "dev_ui_wait_text", arguments: { text: "已生效", timeoutMs: 3000 } }));
if (!stillApplied.ok) fail("取消路径后操作不再是已生效：撤销被意外执行");
const readAfterCancel = unwrap(await call(7, "tools/call", { name: "dev_ui_read", arguments: {} }));
if (JSON.stringify(readAfterCancel.page?.bodyTextSnippet ?? "").includes("已撤销：")) fail("取消路径出现了撤销成功提示");
if (readAfterCancel.page?.dialogPristine !== true) fail("取消路径后 dialogPristine 不为 true");

// 4. 同意路径：confirm:true → 撤销执行，精确回移
const agreeClick = unwrap(await call(8, "tools/call", { name: "dev_ui_click", arguments: { text: "撤销这次归并", confirm: true } }));
if (!agreeClick.ok) fail(`同意路径点击失败：${agreeClick.error}`);
if (agreeClick.confirm !== true) fail("confirm:true 未传递到驱动");
if (agreeClick.dialogPristine !== true) fail("同意点击后 confirm/alert 未恢复原实现");
const reverted = unwrap(await call(9, "tools/call", { name: "dev_ui_wait_text", arguments: { text: "已撤销：", timeoutMs: 8000 } }));
if (!reverted.ok) fail("confirm:true 后没有出现「已撤销：N 条材料移回原作用域」提示");
const readAfterAgree = unwrap(await call(10, "tools/call", { name: "dev_ui_read", arguments: {} }));
if (readAfterAgree.page?.dialogPristine !== true) fail("同意路径后 dialogPristine 不为 true");

server.kill();
console.log("CONFIRM-CANCEL-PASS");
