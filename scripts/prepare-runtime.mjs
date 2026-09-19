import { copyFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "build-assets", "runtime");

mkdirSync(runtimeDir, { recursive: true });
copyFileSync(process.execPath, join(runtimeDir, "node.exe"));
console.log(`copied ${process.execPath} -> build-assets/runtime/node.exe`);

if (existsSync(join(root, "build-assets", "prod"))) {
  rmSync(join(root, "build-assets", "prod"), { recursive: true, force: true });
}
console.log("skipped node_modules copy; server is a single bundled file");
