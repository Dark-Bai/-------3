import path from "path"
import fs from "fs"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// 每次构建为 SW 生成新缓存版本名(cockpit-static-<ts>): SW 更新后 activate 会清掉旧版本缓存,
// 避免浏览器命中历史 bundle 导致"新构建不生效"(需强刷才恢复)的问题
function swCacheBust() {
  return {
    name: "sw-cache-bust",
    apply: "build" as const,
    closeBundle() {
      const swPath = path.resolve(__dirname, "dist/sw.js");
      if (!fs.existsSync(swPath)) return;
      const ver = `cockpit-static-${Date.now().toString(36)}`;
      fs.writeFileSync(
        swPath,
        fs.readFileSync(swPath, "utf-8").replace(/cockpit-static-v\d+/, ver)
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react(), swCacheBust()],
  // 构建时间注入, TV 调试角标用来确认服务器是否已部署新版
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 3000,
    proxy: {
      // 后端数据代理见 server/index.cjs(开发时由 `npm run dev` 自动以 PORT=3001 启动)
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
