import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const portableSrc = join(root, "src-tauri", "target", "release", "OneLedger.exe");
const outDir = join(root, "release");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const setup = join(nsisDir, `OneLedger_${version}_${process.arch}-setup.exe`);
if (!existsSync(setup)) {
  throw new Error(`Tauri NSIS installer missing for v${version} (${process.arch}): ${setup}`);
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
