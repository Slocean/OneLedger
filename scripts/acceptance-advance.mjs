const res = await fetch("http://127.0.0.1:17443/api/remember", {
  method: "POST",
  headers: { "x-admin-token": (process.env.ONELEDGER_ADMIN_TOKEN || ""), "content-type": "application/json" },
  body: JSON.stringify({ body: "第二个人推进的版本：服务器已更新到 rev 2。", scopeKind: "project", scopeId: "skills" + String.fromCharCode(92) + "system" + String.fromCharCode(92) + "plugin", expectedRev: 1 }),
});
const d = await res.json();
console.log("advance:", d.status, "rev", d.rev);
