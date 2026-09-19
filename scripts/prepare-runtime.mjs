import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "build-assets", "runtime");
const prodModules = join(root, "build-assets", "prod", "node_modules");
const skip = new Set([
  ".bin",
  "electron",
  "electron-builder",
  "electron-winstaller",
  "app-builder-lib",
  "app-builder-bin",
  "vite",
  "vitest",
  "tsx",
  "typescript",
  "react",
  "react-dom",
  "@types",
  "@vitejs",
  "@esbuild",
  "esbuild",
]);

mkdirSync(runtimeDir, { recursive: true });
copyFileSync(process.execPath, join(runtimeDir, "node.exe"));
console.log(`copied ${process.execPath} -> build-assets/runtime/node.exe`);

if (existsSync(join(root, "build-assets", "prod"))) {
  rmSync(join(root, "build-assets", "prod"), { recursive: true, force: true });
}
mkdirSync(prodModules, { recursive: true });
for (const name of readdirSync(join(root, "node_modules"))) {
  if (skip.has(name) || name.startsWith("@electron") || name.startsWith("electron-")) continue;
  cpSync(join(root, "node_modules", name), join(prodModules, name), { recursive: true });
}
console.log("prepared production node_modules for the desktop bundle");
