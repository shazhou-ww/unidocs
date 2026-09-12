import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryTransport, createTenantPortalClient, sampleSeed } from "@unidocs/tenant-portal-client";
import { App } from "./app.js";

// 本轮没有真后端：注入假 transport，Agent 在每次写请求后自动接手一轮。
const client = createTenantPortalClient({
  tenantId: "t1",
  transport: createMemoryTransport({ seed: sampleSeed(), agent: { autoRun: true } }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><App client={client} /></StrictMode>,
);
