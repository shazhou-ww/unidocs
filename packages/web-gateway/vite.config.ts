import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The gateway webui is served under /ui/ (and at the bare domain root) by the
 * gateway worker, which embeds the built assets. In dev, Vite serves the SPA
 * and proxies /gw/* to the local gateway (see stacks/unidocs-cloudflare/local).
 */
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      "/gw": {
        target: process.env.GATEWAY_URL || "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gw/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Deterministic asset names (same convention as @unicas/admin-webui).
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
