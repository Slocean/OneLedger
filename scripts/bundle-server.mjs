import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(root, "dist", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: "import { createRequire as __olRequire } from 'node:module'; const require = __olRequire(import.meta.url);",
  },
});

const bytes = statSync(join(root, "dist", "index.js")).size;
console.log(`bundled server -> dist/index.js (${(bytes / 1024).toFixed(1)} KB)`);
