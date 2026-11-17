import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 监听 ::（双栈）：127.0.0.1、localhost、[::1] 三种写法都能进。
    // 只绑 ::1 或只绑 127.0.0.1 都会让其中一种"打不开"，这个坑踩过两次了。
    host: "::",
    proxy: {
      "/api": { target: process.env.GALGAME_API ?? "http://127.0.0.1:8787", changeOrigin: true },
    },
    // Windows 上编辑器的"临时目录 + 改名"保存会留下 .xxx.tmpdir，fs.watch 进到里面会 EBUSY 把 dev server 打死
    watch: { ignored: ["**/.*.tmpdir/**", "**/.*.tmp"] },
  },
  build: { outDir: "dist" },
});
