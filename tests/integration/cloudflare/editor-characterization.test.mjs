import { afterAll, beforeAll } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { runBehaviorSuite } from "../shared/behavior-suite.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: { gateway: 31787, markdown: 31788, cas: 31791, admin: 31792, mockOidc: 31793 },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

runBehaviorSuite(() => runtime);
