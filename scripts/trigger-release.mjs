#!/usr/bin/env node
/**
 * 本地一条命令打 vX.Y.Z tag 并推送，触发 GitHub Actions 打包发版。
 *
 *   node scripts/trigger-release.mjs
 *   node scripts/trigger-release.mjs 0.4.1
 *   release.bat
 *
 * 版本须与 package.json 一致。同名 tag 已存在时先删再重打；低于远端其他最新版本会拒绝。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_PREFIX = "v";

function run(cmd, args) {
  console.log("+", [cmd, ...args].join(" "));
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
}

function output(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

function versionKey(version) {
  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error("版本号必须是无前导零的 X.Y.Z，例如 0.2.0");
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function cmpVersion(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return String(pkg.version || "").trim().replace(/^v/, "");
}

function parseArgs(argv) {
  let version = "";
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    }
    if (version) {
      throw new Error("只能指定一个版本号");
    }
    version = arg.trim().replace(/^v/, "");
  }
  return version;
}

function remoteVersions() {
  const raw = output("git", ["ls-remote", "--tags", "--refs", "origin", `refs/tags/${TAG_PREFIX}*`]);
  const versions = [];
  const prefix = `refs/tags/${TAG_PREFIX}`;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const ref = line.split("\t").at(-1)?.trim() ?? "";
    if (!ref.startsWith(prefix)) continue;
    const version = ref.slice(prefix.length);
    if (VERSION_RE.test(version)) versions.push(version);
  }
  return versions;
}

function ensureReleaseVersionAllowed(version, existing) {
  const replaceExisting = existing.includes(version);
  const peers = existing.filter((item) => item !== version);
  if (peers.length > 0) {
    const latestPeer = peers.reduce((max, item) => (cmpVersion(item, max) > 0 ? item : max));
    if (cmpVersion(version, latestPeer) <= 0) {
      throw new Error(`版本必须递增：目标 v${version}，远端最新版本为 v${latestPeer}`);
    }
  }
  return replaceExisting;
}

function deleteTag(tag, remote) {
  const local = output("git", ["tag", "--list", tag]);
  if (local) run("git", ["tag", "-d", tag]);
  if (!remote) return;
  try {
    run("git", ["push", "origin", "--delete", tag]);
  } catch {
    try {
      run("git", ["push", "origin", `:refs/tags/${tag}`]);
    } catch (error) {
      console.log(`! 远端 tag ${tag} 删除失败（可能已不存在）: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function main() {
  const channelVersion = readPackageVersion();
  const requested = parseArgs(process.argv.slice(2));
  const version = requested || channelVersion;
  if (!version) {
    throw new Error("没有版本号：请在 package.json 填写 version，或传参");
  }
  versionKey(version);
  if (version !== channelVersion) {
    throw new Error(`参数版本 v${version} 与 package.json 当前版本 v${channelVersion} 不一致；请先改版本号`);
  }
  run("node", ["scripts/validate-release.mjs"]);

  let existing;
  try {
    existing = remoteVersions();
  } catch (error) {
    throw new Error(`无法读取 origin 远端 tag，已中止发布：${error instanceof Error ? error.message : error}`);
  }
  const replaceExisting = ensureReleaseVersionAllowed(version, existing);
  const tag = `${TAG_PREFIX}${version}`;
  const localExists = Boolean(output("git", ["tag", "--list", tag]));
  if (replaceExisting || localExists) {
    console.log(`发现已有 tag ${tag}，先删除后再重打`);
    deleteTag(tag, replaceExisting);
  }

  console.log(`打 tag ${tag} 并推送到 origin -> 自动触发 Release Action`);
  run("git", ["tag", tag]);
  run("git", ["push", "origin", tag]);
  console.log("OK: 已推送 tag，去看打包进度：");
  console.log("  https://github.com/Slocean/OneLedger/actions");
  console.log("  https://github.com/Slocean/OneLedger/releases");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
