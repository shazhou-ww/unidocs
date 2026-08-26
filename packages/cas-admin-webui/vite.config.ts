import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The admin console is served under `/admin/` on the CAS service domain;
 * the BFF owns `/admin/me`, `/admin/stacks/...` and the OIDC routes. In dev,
 * Vite serves the SPA and proxies every other `/admin` path (API + OIDC) to
 * the local BFF Worker (see stacks/cloudflare/local).
 */
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4070,
    proxy: {
      "/admin": {
        target: "http://localhost:8792",
        changeOrigin: true,
        // Proxy ONLY the BFF-owned paths; everything else (the SPA shell,
        // assets, Vite module graph: /admin/src/*, /admin/@vite/*,
        // /admin/@react-refresh, pre-bundled deps) is served by Vite.
        bypass: (req) => {
          const path = req.url ?? "";
          const isBffRoute =
            path === "/admin/me"
            || path.startsWith("/admin/stacks")
            || path.startsWith("/admin/member-invitations")
            || path.startsWith("/admin/auth/")
            || path === "/admin/issuer/possession-challenge"
            || path.startsWith("/admin/invitations/");
          if (isBffRoute) return undefined; // forward to the BFF worker
          return path; // serve from Vite
        },
      },
    },
  },
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    // Deterministic asset names: the BFF shell hardcodes /admin/assets/main.js
    // (and main.css), so the entry/chunk names must not be hashed.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
  },
});
