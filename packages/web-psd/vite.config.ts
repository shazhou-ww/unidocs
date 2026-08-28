import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The gateway URL is injected by the dev runtime (scripts/dev.mjs); falls back
// to the default local gateway when web-psd is started on its own.
const gateway = process.env.GATEWAY_URL || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin `/gw/*` → gateway (avoids CORS). `/gw` prefix is stripped.
      "/gw": {
        target: gateway,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gw/, ""),
      },
    },
  },
  test: {
    // jsdom (not admin-webui's "node") because every test here renders DOM.
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
