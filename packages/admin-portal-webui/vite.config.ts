import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4170,
    proxy: {
      "/admin/api": "http://127.0.0.1:8788",
      "/admin/auth": "http://127.0.0.1:8788",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      }
    },
  },
  test: { environment: "jsdom", globals: true, pool: "forks", setupFiles: ["./tests/setup.ts"] },
});