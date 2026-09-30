// MCP memory.get 验收：ZCode 自己以 Agent 密钥直连 Tauri 内嵌 HTTP MCP。
const key = JSON.parse((await import("node:fs")).readFileSync("C:/Users/bigse/AppData/Local/Temp/ol-acc-key.json", "utf8"));

async function mcp(payload) {
  const res = await fetch("http://127.0.0.1:17443/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "zcode-acceptance", version: "0" } } });
console.log("initialize:", init.result?.serverInfo?.name, init.result?.serverInfo?.version);
console.log("instructions head:", (init.result?.instructions ?? "").slice(0, 60));

const get = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory.get", arguments: { scopeKind: "project", scopeId: "skills\\system\\plugin" } } });
const text = get.result?.content?.[0]?.text ?? "";
const parsed = JSON.parse(text);
console.log("memory.get results:", parsed.length, "| rev:", parsed[0]?.rev, "| body head:", parsed[0]?.body?.slice(0, 40));

const badScope = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory.get", arguments: { scopeKind: "project", scopeId: "ConflictScope" } } });
const badParsed = JSON.parse(badScope.result?.content?.[0]?.text ?? "[]");
console.log("ConflictScope get:", badParsed.length, "result(s), title:", badParsed[0]?.title);
