// 剩余批次（file DB）服务端延迟计时：batch 2/3。
const TOKEN = (process.env.ONELEDGER_ADMIN_TOKEN || "");
const BS = String.fromCharCode(92);
const fromScope = "batch" + BS + "scope";
const post = async (path, body) =>
  (
    await fetch(`http://127.0.0.1:17443${path}`, {
      method: "POST",
      headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
for (let batch = 2; batch <= 3; batch += 1) {
  const t0 = Date.now();
  const preview = await post("/api/scopes/merge/preview", { fromScopeKind: "project", fromScopeId: fromScope, toScopeId: "BatchTarget" });
  if (preview.status !== "ok") {
    console.log(`batch ${batch}: preview error`, preview.error);
    break;
  }
  const confirm = await post("/api/scopes/merge/confirm", { fromScopeKind: "project", fromScopeId: fromScope, toScopeId: "BatchTarget", digest: preview.digest });
  console.log(`batch ${batch}: preview+confirm ${Date.now() - t0}ms, status ${confirm.status}, moved ${confirm.moved}, remaining ${confirm.remaining}`);
}
