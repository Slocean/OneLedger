/**
 * 检索评测（计划书第 5 步）。
 *
 * 使用独立临时库，不触碰用户正在使用的数据。语料不含真实凭据。
 * 运行：npx tsx scripts/retrieval-eval.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { openDb } from "../src/db/driver.js";
import { MemoryService } from "../src/memory/service.js";
import { Store } from "../src/memory/store.js";
import { scanAndRedact } from "../src/security/scan.js";

interface Doc {
  id: string;
  scopeKind: "global" | "project" | "personal";
  scopeId: string;
  title: string;
  body: string;
}

interface QueryCase {
  query: string;
  expect: string[];
  forbid: string[];
  category: string;
}

const DOCS: Doc[] = [
  { id: "doc-project-collect", scopeKind: "project", scopeId: "CofoeAirLink_Web", title: "采集约定", body: "采集器只读取约定文件与会话摘要，排除 vendor_imports 与虚拟环境。蒸馏后覆盖整篇项目记忆。" },
  { id: "doc-project-frontend", scopeKind: "project", scopeId: "CofoeAirLink_App", title: "前端约定", body: "Vite 前端固定使用 3001 端口，组件目录按业务模块划分。" },
  { id: "doc-project-rwt", scopeKind: "project", scopeId: "RollTheWarTable", title: "跨项目说明", body: "RollTheWarTable 的域名工作树放在 RWT-ai 目录下，发布走独立仓库。" },
  { id: "doc-global-workflow", scopeKind: "global", scopeId: "", title: "协作方式", body: "用户沟通直接、结果导向；反感铺垫与说教。交付成果即可，不要解释过程有多难。" },
  { id: "doc-project-tooling", scopeKind: "project", scopeId: "OneLedger", title: "工具口径", body: "包管理统一用 pnpm，提交前跑一次类型检查；禁止 Electron，桌面壳只用 Tauri。" },
  { id: "doc-personal-note", scopeKind: "personal", scopeId: "", title: "个人习惯", body: "个人偏好：先看日志再改代码，避免盲改。" },
];

const CASES: QueryCase[] = [
  { query: "约定文件", expect: ["doc-project-collect"], forbid: [], category: "中文短语(trigram)" },
  { query: "蒸馏后覆盖", expect: ["doc-project-collect"], forbid: [], category: "中文短语(trigram)" },
  { query: "3001 端口", expect: ["doc-project-frontend"], forbid: [], category: "中文+数字" },
  { query: "包管理 pnpm", expect: ["doc-project-tooling"], forbid: [], category: "英文关键词" },
  { query: "Tauri", expect: ["doc-project-tooling"], forbid: [], category: "英文关键词" },
  { query: "RWT-ai", expect: ["doc-project-rwt"], forbid: [], category: "英文标识符" },
  { query: "结果导向 说教", expect: ["doc-global-workflow"], forbid: [], category: "中文短语" },
  { query: "先看日志", expect: ["doc-personal-note"], forbid: [], category: "中文短语(个人作用域)" },
  { query: "Vite 前端 3001", expect: ["doc-project-frontend"], forbid: [], category: "双语混排" },
  { query: "约定", expect: ["doc-project-collect"], forbid: [], category: "中文两字短词(LIKE)" },
  { query: "日志", expect: ["doc-personal-note"], forbid: [], category: "中文两字短词(LIKE)" },
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oneledger-eval-"));
  const config = defaultConfig();
  config.storage.sqlitePath = join(dir, "eval.db");
  config.security.allowInternalInSearch = true;
  const db = await openDb(config);
  const store = new Store(db);
  const service = new MemoryService(store, config);

  const idMap = new Map<string, string>();
  for (const doc of DOCS) {
    const saved = await service.remember({
      body: doc.body,
      title: doc.title,
      scopeKind: doc.scopeKind,
      scopeId: doc.scopeId,
      source: "mcp:eval",
      actor: "eval",
      expectedRev: 0,
    });
    if (!saved.memoryId) throw new Error(`语料写入失败：${doc.id} -> ${saved.status}`);
    idMap.set(doc.id, saved.memoryId);
  }

  // 边界语料：secret / pii / 未蒸馏材料
  await store.insertInbox({
    title: "秘密材料",
    body: "凭据 sk-abcdefghijklmnopqrstuvwxyz123456 不得被检索",
    source: "cursor",
    scopeKind: "project",
    scopeId: "CofoeAirLink_Web",
    sensitivity: "secret",
    redacted: 1,
    queueStatus: "proposed",
    conflictIds: [],
  });
  await store.insertInbox({
    title: "未审核草稿",
    body: "未经审核的草稿正文不得被检索",
    source: "cursor",
    scopeKind: "project",
    scopeId: "CofoeAirLink_Web",
    sensitivity: "public",
    redacted: 0,
    queueStatus: "proposed",
    conflictIds: [],
  });
  const piiText = scanAndRedact("联系 zhang.san@example.com 处理").cleanText;
  await store.upsertMemory({
    id: "mem_pii_eval",
    rev: 1,
    title: "联系人",
    body: piiText,
    scopeKind: "project",
    scopeId: "CofoeAirLink_Web",
    sensitivity: "pii",
    status: "active",
    source: "mcp:eval",
    originNode: "eval",
    contentHash: "pii-eval",
    supersededBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    forgottenAt: null,
  });

  const reverse = new Map([...idMap.entries()].map(([key, value]) => [value, key]));
  let hits = 0;
  let p5Hits = 0;
  let falseHits = 0;

  console.log("查询\t类别\t命中\tP@5\t耗时ms\t返回");
  for (const item of CASES) {
    const started = Date.now();
    const results = await service.search(item.query, "eval", 8);
    const elapsed = Date.now() - started;
    const ids = results.map((row) => reverse.get(row.id) ?? row.id);
    const matched = item.expect.filter((id) => ids.includes(id));
    const top5 = item.expect.filter((id) => ids.slice(0, 5).includes(id));
    const unexpected = ids.filter((id) => !item.expect.includes(id));
    hits += matched.length;
    p5Hits += top5.length;
    falseHits += unexpected.length;
    console.log(
      `${item.query}\t${item.category}\t${matched.length}/${item.expect.length}\t${top5.length}/${item.expect.length}\t${elapsed}\t${ids.join(",") || "(空)"}`,
    );
  }

  const totalExpected = CASES.reduce((sum, item) => sum + item.expect.length, 0);
  console.log(`\n命中率 ${hits}/${totalExpected} = ${((hits / totalExpected) * 100).toFixed(1)}%`);
  console.log(`前五命中率 ${p5Hits}/${totalExpected} = ${((p5Hits / totalExpected) * 100).toFixed(1)}%`);
  console.log(`误召回 ${falseHits} 条`);

  console.log("\n边界用例");
  const secretHits = await service.search("不得被检索", "eval", 8);
  console.log(`B1 secret 零返回: ${secretHits.length === 0 ? "PASS" : `FAIL(${secretHits.length})`}`);
  const piiHits = await service.search("zhang.san", "eval", 8);
  console.log(`B2 pii 零返回: ${piiHits.length === 0 ? "PASS" : `FAIL(${piiHits.length})`}`);
  const draftHits = await service.search("未审核草稿正文", "eval", 8);
  console.log(`B3 未蒸馏材料零返回: ${draftHits.length === 0 ? "PASS" : `FAIL(${draftHits.length})`}`);
  const none = await service.search("zzz不存在的词语qqq", "eval", 8);
  console.log(`B4 不存在词零返回: ${none.length === 0 ? "PASS" : `FAIL(${none.length})`}`);
  const scoped = await service.search("工作树", "eval", 8, { scopeId: "RollTheWarTable" });
  const scopedIds = scoped.map((row) => reverse.get(row.id) ?? row.id);
  console.log(`B5 作用域过滤: ${scopedIds.every((id) => id === "doc-project-rwt") ? "PASS" : `FAIL(${scopedIds.join(",")})`}`);

  await db.close();
  rmSync(dir, { recursive: true, force: true });
}

void main();
