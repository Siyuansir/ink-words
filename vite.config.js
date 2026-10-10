import { resolve } from "path";
import { defineConfig } from "vite";

// base 用相对路径 './'，GitHub Pages 部署到任意仓库子路径都可用
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        "404": resolve(__dirname, "404.html"),
      },
    },
  },
});