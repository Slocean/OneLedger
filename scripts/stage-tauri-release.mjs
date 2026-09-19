import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const portableSrc = join(root, "src-tauri", "target", "release", "OneLedger.exe");
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
if (!existsSync(portableSrc)) {
  throw new Error(`portable exe missing: ${portableSrc}`);
}

mkdirSync(outDir, { recursive: true });
const setupDest = join(outDir, "OneLedger-Setup.exe");
const portableDest = join(outDir, "OneLedger-Portable.exe");
copyFileSync(setup, setupDest);
copyFileSync(portableSrc, portableDest);
writeFileSync(join(outDir, "ONELEDGER_SOURCE.txt"), `setup ${setup}\nportable ${portableSrc}\n`);
console.log(`installer -> ${setupDest}`);
console.log(`portable  -> ${portableDest}`);
