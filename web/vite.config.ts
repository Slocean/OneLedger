import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// B-08：dev 验收 driver 只在显式设置 ONELEDGER_DEV_DRIVER=1 的构建中编译进产物；
// 正式 `npm run build` / `tauri:build` 完全不含该模块。
const devDriver = process.env.ONELEDGER_DEV_DRIVER === "1";

export default defineConfig({
  plugins: [react()],
  root: resolve(import.meta.dirname),
  define: {
    __ONELEDGER_DEV_DRIVER__: JSON.stringify(devDriver),
  },
  build: {
    outDir: resolve(import.meta.dirname, "../dist/web"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:7443",
      "/mcp": "http://127.0.0.1:7443",
    },
  },
});
