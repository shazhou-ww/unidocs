import { afterAll, beforeAll } from "vitest";
import { startAzureRuntime } from "../../../scripts/azure-runtime.mjs";
import { runBehaviorSuite } from "../shared/behavior-suite.mjs";

let runtime;

// Boots docker-compose.azure.yml (Postgres only — Azurite is a spawned
// `azurite-blob` Node process now, no image), applies migrations, and spawns
// the azurite-blob/azure-gateway/azure-markdown Node processes — see
// scripts/azure-runtime.mjs. Generous timeout: on a cold Docker daemon this
// still pays for one image pull (`postgres:18-alpine`, ~100 MB) plus two
// esbuild bundles and three process starts, all slower than Miniflare's
// in-process boot.
beforeAll(async () => {
  runtime = await startAzureRuntime();
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
}, 60_000);

runBehaviorSuite(() => runtime);
