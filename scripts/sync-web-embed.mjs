import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "dist", "web");
const dest = join(root, "src-tauri", "web-assets");
if (!existsSync(join(src, "index.html"))) {
  throw new Error("dist/web/index.html missing. Run the Vite build first.");
}
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`web assets -> ${dest}`);
