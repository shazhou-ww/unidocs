import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startLocalRuntime({ docTypes: [], services: ["portal"] });
}, 120_000);

afterAll(async () => {
  await runtime?.mf?.dispose();
});

describe("portal worker CAS bindings", () => {
  it("receives a CAS origin, stack identity, audience and ref domain", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.CAS_ORIGIN).toMatch(/^https?:\/\//);
    expect(bindings.CAS_STACK_ID).toBeTruthy();
    expect(bindings.CAS_AUDIENCE).toBeTruthy();
    expect(bindings.CAS_REF_DOMAIN).toBe("doc");
  });

  it("receives the stack signing key, not the gateway one", async () => {
    const bindings = await runtime.mf.getBindings("unidocs-portal");
    expect(bindings.CAS_SIGNING_KEY).toContain("BEGIN PRIVATE KEY");
    expect(bindings.CAS_SIGNING_KID).toMatch(/^stack-local-/);
    expect(bindings.CAS_ISSUER).not.toMatch(/^unidocs-gateway:/);
  });
});
