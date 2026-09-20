#!/usr/bin/env node
/**
 * 发版前校验：app_update.json 必须是合法 JSON，history[0].version 必须等于 package.json。
 *
 *   node scripts/validate-release.mjs
 *   node scripts/validate-release.mjs --notes
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(path, label) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : error}`);
  }
}

function main() {
  const pkg = readJson(join(ROOT, "package.json"), "package.json");
  const version = String(pkg.version || "").trim().replace(/^v/, "");
  if (!VERSION_RE.test(version)) {
    throw new Error(`package.json version 无效：${version || "(空)"}`);
  }

  const channel = readJson(join(ROOT, "app_update.json"), "app_update.json");
  const history = channel?.history;
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error("app_update.json 缺少非空 history");
  }
  const latest = history[0] && typeof history[0] === "object" ? history[0] : null;
  if (!latest) {
    throw new Error("app_update.json history[0] 必须是对象");
  }
  const latestVersion = String(latest.version ?? "").trim().replace(/^v/, "");
  const title = String(latest.title ?? "").trim();
  const body = String(latest.body ?? "").trim();
  if (latestVersion !== version) {
    throw new Error(`app_update.json 最新版本 ${latestVersion || "(空)"} 与 package.json ${version} 不一致`);
  }
  if (!title || !body) {
    throw new Error("app_update.json history[0] 需要非空 title 和 body");
  }

  const svg = readFileSync(join(ROOT, "brand", "oneledger.svg"), "utf8");
  if (!svg.includes("<svg") || !svg.includes("#c4a35a") || !svg.includes("#14110d")) {
    throw new Error("brand/oneledger.svg 必须是账本配色的 SVG 源");
  }
  for (const name of ["nsis-header.svg", "nsis-sidebar.svg"]) {
    const sheet = readFileSync(join(ROOT, "brand", name), "utf8");
    if (!sheet.includes("<svg") || !sheet.includes("#c4a35a")) {
      throw new Error(`brand/${name} 必须从同一套 SVG 账本图标画出`);
    }
  }

  if (process.argv.includes("--notes")) {
    writeFileSync(join(ROOT, "release-notes.md"), [title, "", body].join("\n"));
  }
  console.log(`OK: 通道 v${version} · ${title}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
