import { cpSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "release", `oneledger-${pkg.version}`);
if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const item of ["dist", "package.json", "package-lock.json", "LICENSE", "README.md"]) {
  cpSync(join(root, item), join(out, item), { recursive: true });
}

writeFileSync(
  join(out, "OneLedger.cmd"),
  `@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Need Node.js 22+ & exit /b 1)
if not exist node_modules call npm ci --omit=dev
node dist\\index.js serve
`,
);
writeFileSync(
  join(out, "OneLedger-mcp.cmd"),
  `@echo off
cd /d "%~dp0"
if not exist node_modules call npm ci --omit=dev
node dist\\index.js mcp
`,
);
writeFileSync(
  join(out, "latest.json"),
  `${JSON.stringify({ name: "oneledger", version: pkg.version, protocol: 1 }, null, 2)}\n`,
);
writeFileSync(
  join(out, "HOW-TO-RUN.txt"),
  `1. Install Node.js 22+
2. Double-click OneLedger.cmd
3. Open http://127.0.0.1:7443/
4. Admin token: %USERPROFILE%\\.oneledger\\config.json
5. Point another machine's role=leaf remoteUrl at this hub to sync.
`,
);

console.log(`packed ${out}`);
