#!/usr/bin/env node
// OneLedger 开发 MCP（stdio）：把 dev_ui_* 工具转发到隔离验收实例的
// /api/dev/ui/exec，由 Tauri 窗口 WebView 内的 dev driver 执行 DOM 级操作。
// 仅用于本仓库的自动化验收；通道要求实例 config.devUi=true 且 admin token 匹配，
// 真实实例默认关闭（404），本 server 对其不可用。
//
// 环境变量：
//   ONELEDGER_DEV_URL      隔离实例地址（默认 http://127.0.0.1:17443）
//   ONELEDGER_ADMIN_TOKEN  该实例 config.json 的 adminToken

import { createInterface } from "node:readline";

const BASE = process.env.ONELEDGER_DEV_URL || "http://127.0.0.1:17443";
const TOKEN = process.env.ONELEDGER_ADMIN_TOKEN || "";

const TOOLS = [
  {
    name: "dev_ui_click",
    description:
      "在 OneLedger Tauri 窗口内点击一个可见元素。用 text（按钮/链接可见文字片段）或 CSS selector 定位。" +
      "确认/取消语义（B-08/第六轮）：confirm 缺省为 false=「取消」——点击期间页面弹出的原生 confirm 按取消处理；" +
      "只有显式传 confirm:true 才在这一次同步点击内模拟「用户同意」。两种选择都仅在该次同步调用内生效、" +
      "调用后立即恢复浏览器原实现（可用 dev_ui_read 的 dialogPristine 断言）。验收确认类操作必须显式走 confirm:true，" +
      "取消分支用缺省点击验证。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "可见文字片段，如「审核 / 整理」" },
        selector: { type: "string", description: "CSS 选择器，如 input[type=checkbox]" },
        nth: { type: "number", description: "第几个匹配（从 0 起），默认 0" },
        confirm: { type: "boolean", description: "缺省 false=取消原生 confirm；仅 true=同意。必须显式传入才同意" },
      },
    },
  },
  {
    name: "dev_ui_fill",
    description: "向窗口内的输入框/文本域填入文本（触发 React 受控更新）。用 selector 定位，或 text 匹配相邻 label。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string", description: "按钮/label 文字片段（兜底定位）" },
        value: { type: "string" },
        nth: { type: "number" },
      },
      required: ["value"],
    },
  },
  {
    name: "dev_ui_read",
    description: "读取窗口内当前页面的结构化快照：标题、按钮、输入框、勾选状态、提示/错误文本、任务卡片等。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dev_ui_wait_text",
    description: "等待窗口内出现指定文本（轮询 DOM），用于确认操作结果出现。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        timeoutMs: { type: "number", description: "默认 5000，上限 60000" },
      },
      required: ["text"],
    },
  },
  {
    name: "dev_health",
    description: "读取隔离实例的 /api/health 与 /api/version（不经窗口）。",
    inputSchema: { type: "object", properties: {} },
  },
];

async function execUi(command) {
  const response = await fetch(`${BASE}/api/dev/ui/exec`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function callTool(name, args) {
  switch (name) {
    case "dev_ui_click": {
      const { status, body } = await execUi({ kind: "click", text: args.text, selector: args.selector, nth: args.nth, confirm: args.confirm === true });
      return { status, body };
    }
    case "dev_ui_fill": {
      const { status, body } = await execUi({ kind: "fill", selector: args.selector, text: args.text, value: args.value, nth: args.nth });
      return { status, body };
    }
    case "dev_ui_read": {
      const { status, body } = await execUi({ kind: "read" });
      return { status, body };
    }
    case "dev_ui_wait_text": {
      const { status, body } = await execUi({ kind: "waitText", text: args.text, timeoutMs: Math.min(args.timeoutMs ?? 5000, 60_000) });
      return { status, body };
    }
    // dev_eval 已删除（B-08）：窗口驱动没有任何任意 JS 执行能力，工具清单与之保持一致。
    case "dev_health": {
      const [health, version] = await Promise.all([
        fetch(`${BASE}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) })),
        fetch(`${BASE}/api/version`).then((r) => r.json()).catch((e) => ({ error: String(e) })),
      ]);
      return { status: 200, body: { health, version } };
    }
    default:
      return { status: 404, body: { error: `unknown tool ${name}` } };
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || message.id === undefined) return; // notification
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "oneledger-dev", version: "0.1.0" },
      instructions:
        "OneLedger 开发验收工具：直接驱动 Tauri 窗口内的 UI（点击/输入/读取/等待文本）。先 dev_ui_read 了解页面，再交互；每次交互后用 dev_ui_wait_text 或 dev_ui_read 确认结果。",
    });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name ?? "";
    const args = params?.arguments ?? {};
    callTool(name, args)
      .then(({ status, body }) => {
        const text = JSON.stringify(body, null, 1);
        reply(id, { content: [{ type: "text", text: status >= 400 ? `HTTP ${status}: ${text}` : text }], isError: status >= 400 });
      })
      .catch((error) => {
        reply(id, { content: [{ type: "text", text: String(error) }], isError: true });
      });
    return;
  }
  reply(id, { error: { code: -32601, message: method ?? "" } });
});
