import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  root: resolve(import.meta.dirname),
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
