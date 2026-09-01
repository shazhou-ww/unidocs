import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The gateway origin is injected by the dev runtime (scripts/dev.mjs) or set
// as VITE_GATEWAY_URL at build time; the app is same-origin with the gateway
// in production (served by the gateway worker under /ui/), so the default is
// the current origin and the dev server proxies /gw/* to the local gateway.
const gateway = process.env.GATEWAY_URL || "http://127.0.0.1:8787";

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      "/gw": {
        target: gateway,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gw/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
