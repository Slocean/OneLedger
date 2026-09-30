// 创建真实归并操作（tiny\merge → RealTarget），供操作列表页 2 撤销验收。
const TOKEN = (process.env.ONELEDGER_ADMIN_TOKEN || "");
const BS = String.fromCharCode(92);
const fromScope = "tiny" + BS + "merge";
const post = async (path, body) =>
  (
    await fetch(`http://127.0.0.1:17443${path}`, {
      method: "POST",
      headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
const preview = await post("/api/scopes/merge/preview", { fromScopeKind: "project", fromScopeId: fromScope, toScopeId: "RealTarget" });
console.log("preview:", preview.status, "batch:", preview.batch);
if (preview.status !== "ok") process.exit(1);
const confirm = await post("/api/scopes/merge/confirm", { fromScopeKind: "project", fromScopeId: fromScope, toScopeId: "RealTarget", digest: preview.digest });
console.log("confirm:", confirm.status, "moved:", confirm.moved, "opId:", confirm.operationId);
(await import("node:fs")).writeFileSync("C:/Users/bigse/AppData/Local/Temp/ol-real-op.json", JSON.stringify(confirm));
