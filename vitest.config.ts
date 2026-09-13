import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // SheetJS 0.20.3 CDN 构建：显式钉回 CJS 构建（xlsx.mjs 需手动 set_fs，
      // 且与 mcp-server esbuild bundle 加载行为同源）
      xlsx: path.resolve(__dirname, "node_modules/xlsx/xlsx.js"),
    },
  },
  test: {
    globals: true,
    include: [
      "mcp-server/__tests__/**/*.test.ts",
      "lib/engine/formula-engine/__tests__/**/*.test.ts",
      "lib/table/__tests__/**/*.test.ts",
    ],
  },
});
