import { afterAll, beforeAll } from "vitest";
import { startAzureRuntime } from "../../../stacks/azure/local/runtime.mjs";
import { startLocalRuntime } from "../../../stacks/cloudflare/local/runtime.mjs";
import { runAuthorizationSuite } from "../shared/authorization-suite.mjs";
import { runHttpConformanceSuite } from "../shared/http-conformance-suite.mjs";

let runtime;
let casRuntime;

beforeAll(async () => {
  casRuntime = await startLocalRuntime({
    docTypes: ["markdown"],
    ports: { gateway: 35787, markdown: 35788, cas: 35791, admin: 35792, mockOidc: 35793 },
    internalAuthMode: "capability",
  });
  runtime = await startAzureRuntime({
    docTypes: ["markdown", "docx"],
    internalAuthMode: "capability",
    casBaseUrl: casRuntime.urls.cas,
    capabilityFixture: casRuntime.capabilityFixture,
  });
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await casRuntime?.dispose();
}, 60_000);

runAuthorizationSuite(() => runtime, {
  docTypes: ["markdown", "docx"],
});
runHttpConformanceSuite(() => runtime, {
  provider: "azure",
  snapshotHashPattern: /^[0-9a-f]{16}$/,
  svalueResponses: false,
  validatesExportFormat: false,
});