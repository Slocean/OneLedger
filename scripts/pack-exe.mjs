import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const portable = join(root, "release", "desktop", "OneLedger");
const tools = join(root, "build-assets", "sfx-tools");
const archive = join(root, "release", "OneLedger.7z");
const exeOut = join(root, "release", "OneLedger.exe");
const versionedOut = join(root, "release", `OneLedger-${pkg.version}.exe`);

const SEVEN_ZR_URL = "https://github.com/ip7z/7zip/releases/download/26.03/7zr.exe";
const LZMA_SDK_URL = "https://github.com/ip7z/7zip/releases/download/26.03/lzma2603.7z";
const RCEDIT_URL = "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe";

async function download(url, dest) {
  console.log(`download ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed ${response.status} ${url}`);
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

function run(cmd, args, cwd = root) {
  console.log("+", [cmd, ...args].join(" "));
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function findFile(dir, name) {
  if (!existsSync(dir)) return "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    }
  }
  return "";
}

async function ensureTools() {
  mkdirSync(tools, { recursive: true });
  const sevenZr = join(tools, "7zr.exe");
  const rcedit = join(tools, "rcedit.exe");
  if (!existsSync(sevenZr)) await download(SEVEN_ZR_URL, sevenZr);
  if (!existsSync(rcedit)) await download(RCEDIT_URL, rcedit);

  let sfx = join(tools, "7zS2.sfx");
  if (!existsSync(sfx)) {
    const sdk = join(tools, "lzma2603.7z");
    if (!existsSync(sdk)) await download(LZMA_SDK_URL, sdk);
    run(sevenZr, ["x", sdk, `-o${tools}`, "-y"]);
    const found = findFile(tools, "7zS2.sfx");
    if (!found) throw new Error("7zS2.sfx missing from LZMA SDK");
    copyFileSync(found, sfx);
  }

  // 去掉 SFX 资源里的 Setup 字样，避免每次启动弹 UAC
  run(rcedit, [
    sfx,
    "--set-version-string",
    "FileDescription",
    "OneLedger",
    "--set-version-string",
    "ProductName",
    "OneLedger",
    "--set-version-string",
    "InternalName",
    "OneLedger",
    "--set-version-string",
    "OriginalFilename",
    "OneLedger.exe",
    "--set-file-version",
    pkg.version,
    "--set-product-version",
    pkg.version,
  ]);
  const icon = join(root, "desktop", "icons", "icon.ico");
  if (existsSync(icon)) run(rcedit, [sfx, "--set-icon", icon]);
  return { sevenZr, rcedit, sfx };
}

function stampExe(rcedit, exe) {
  const args = [
    exe,
    "--set-version-string",
    "FileDescription",
    "OneLedger",
    "--set-version-string",
    "ProductName",
    "OneLedger",
    "--set-version-string",
    "CompanyName",
    "OneLedger",
    "--set-version-string",
    "OriginalFilename",
    "OneLedger.exe",
    "--set-file-version",
    pkg.version,
    "--set-product-version",
    pkg.version,
  ];
  const icon = join(root, "desktop", "icons", "icon.ico");
  if (existsSync(icon)) args.push("--set-icon", icon);
  run(rcedit, args);
}

const toolsReady = await ensureTools();
if (!existsSync(join(portable, "OneLedger.exe"))) {
  throw new Error("portable folder missing. Run npm run desktop:pack first.");
}

if (existsSync(archive)) rmSync(archive, { force: true });
run(toolsReady.sevenZr, ["a", "-mx=9", "-r", archive, "*"], portable);

const exe = Buffer.concat([readFileSync(toolsReady.sfx), readFileSync(archive)]);
mkdirSync(dirname(exeOut), { recursive: true });
writeFileSync(exeOut, exe);
stampExe(toolsReady.rcedit, exeOut);
copyFileSync(exeOut, versionedOut);
rmSync(archive, { force: true });
console.log(`single-file exe -> ${exeOut}`);
console.log(`single-file exe -> ${versionedOut}`);
