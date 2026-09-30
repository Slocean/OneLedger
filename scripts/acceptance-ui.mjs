#!/usr/bin/env node
// 窗口验收辅助：顺序执行 dev driver 命令并打印结果。
const BASE = "http://127.0.0.1:17443";
const TOKEN = (process.env.ONELEDGER_ADMIN_TOKEN || "");

async function execUi(command) {
  const res = await fetch(`${BASE}/api/dev/ui/exec`, {
    method: "POST",
    headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await res.json();
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result ?? body;
}

const command = process.argv[2];
const arg = process.argv[3];
const extra = process.argv[4];
const commands = {
  read: () => execUi({ kind: "read" }),
  click: () => execUi({ kind: "click", text: arg }),
  clickConfirm: () => execUi({ kind: "click", text: arg, confirm: true }),
  clickNth: () => execUi({ kind: "click", text: arg, nth: Number(extra) }),
  clickSel: () => execUi({ kind: "click", selector: arg }),
  fill: () => execUi({ kind: "fill", selector: arg, value: extra }),
  wait: () => execUi({ kind: "waitText", text: arg, timeoutMs: 8000 }),
  // eval 能力已删除（B-08）：driver 没有任何任意 JS 执行通道；结构化断言用 read。
};
const result = await commands[command]();
if (result.page) {
  const p = result.page;
  console.log("URL:", p.url);
  console.log("NOTES:", (p.notes ?? []).map((n) => n.text.slice(0, 90)));
  console.log("ITEMS:", (p.items ?? []).map((n) => n.text.slice(0, 90)));
  console.log("CHECKED:", (p.checkboxes ?? []).filter((c) => c.checked).length, "/", (p.checkboxes ?? []).length);
  console.log("BUTTONS:", (p.buttons ?? []).map((b) => b.text.slice(0, 20)));
  console.log("DIALOG:", "pristine=" + p.dialogPristine, "native=" + p.nativeDialogsPresent);
  console.log("SNIPPET:", (p.bodyTextSnippet ?? "").slice(0, 1500));
} else {
  console.log(JSON.stringify(result, null, 1).slice(0, 1200));
}
