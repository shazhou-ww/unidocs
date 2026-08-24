import { afterAll, beforeAll } from "vitest";
import { startLocalRuntime } from "../../../scripts/local-runtime.mjs";
import { runBehaviorSuite } from "../shared/behavior-suite.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: { gateway: 31787, markdown: 31788 },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

runBehaviorSuite(() => runtime);
