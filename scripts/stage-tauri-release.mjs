import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const outDir = join(root, "release");

function findSetup(dir) {
  if (!existsSync(dir)) return "";
  const matches = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .sort((a, b) => {
      const score = (name) => (name.toLowerCase().includes("setup") ? 0 : 1);
      return score(a) - score(b);
    });
  return matches[0] ? join(dir, matches[0]) : "";
}

const setup = findSetup(nsisDir);
if (!setup) {
  throw new Error(`Tauri NSIS installer missing under ${nsisDir}`);
}

mkdirSync(outDir, { recursive: true });
const dest = join(outDir, "OneLedger.exe");
copyFileSync(setup, dest);
writeFileSync(join(outDir, "ONELEDGER_SOURCE.txt"), `${setup}\n`);
console.log(`tauri installer -> ${dest}`);
