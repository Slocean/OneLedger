import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const electronDir = dirname(require.resolve("electron/package.json"));
const electronDist = join(electronDir, "dist");
const out = join(root, "release", "desktop", "OneLedger");

if (!existsSync(join(electronDist, "electron.exe"))) {
  throw new Error("Electron binary missing. Run: node node_modules/electron/install.js");
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(electronDist, out, { recursive: true });

const localesKeep = new Set(["en-US.pak", "zh-CN.pak"]);
const locales = join(out, "locales");
if (existsSync(locales)) {
  for (const name of readdirSync(locales)) {
    if (!localesKeep.has(name)) rmSync(join(locales, name), { force: true });
  }
}

const appDir = join(out, "resources", "app");
mkdirSync(appDir, { recursive: true });
cpSync(join(root, "desktop", "main.mjs"), join(appDir, "main.mjs"));
writeFileSync(
  join(appDir, "package.json"),
  `${JSON.stringify({ name: "oneledger", version: pkg.version, main: "main.mjs", author: "OneLedger" }, null, 2)}\n`,
);

cpSync(join(root, "dist"), join(out, "resources", "app-server", "dist"), { recursive: true });
cpSync(join(root, "package.json"), join(out, "resources", "app-server", "package.json"));
cpSync(join(root, "build-assets", "prod", "node_modules"), join(out, "resources", "app-server", "node_modules"), {
  recursive: true,
});
cpSync(join(root, "build-assets", "runtime"), join(out, "resources", "runtime"), { recursive: true });

renameSync(join(out, "electron.exe"), join(out, "OneLedger.exe"));
writeFileSync(join(out, "启动说明.txt"), "双击 OneLedger.exe 启动。首次会在本机拉起记忆服务，窗口就是管理台。\n");
console.log(`portable app -> ${out}`);
