import { afterAll, beforeAll } from "vitest";
import { startLocalRuntime } from "../../../stacks/cloudflare/local/runtime.mjs";
import { runAuthorizationSuite } from "../shared/authorization-suite.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown", "docx", "psd"],
    ports: {
      gateway: 34787,
      markdown: 34788,
      docx: 34789,
      psd: 34790,
      cas: 34791,
    },
    internalAuthMode: "capability",
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

runAuthorizationSuite(() => runtime, {
  docTypes: ["markdown", "docx", "psd"],
  directCas: true,
});