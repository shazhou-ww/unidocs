import { afterAll, beforeAll } from "vitest";
import { startAzureRuntime } from "./azure-runtime.mjs";
import { runBehaviorSuite } from "./behavior-suite.mjs";

let runtime;

// Boots docker-compose.azure.yml (Postgres + Azurite), applies migrations,
// and spawns the azure-gateway/azure-markdown Node processes — see
// scripts/azure-runtime.mjs. Generous timeout: image pulls/container starts
// on a cold Docker daemon are slower than Miniflare's in-process boot.
beforeAll(async () => {
  runtime = await startAzureRuntime();
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
}, 60_000);

runBehaviorSuite(() => runtime);
