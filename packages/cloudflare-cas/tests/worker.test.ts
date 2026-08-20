import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker";

const TOKEN = "test-internal-token";
const hash = "a".repeat(64);

function env(overrides: Record<string, unknown> = {}) {
  const doFetch = vi.fn(async () => Response.json({ success: true }));
  return {
    INTERNAL_TOKEN: TOKEN,
    CAS_DB: { exec: async () => undefined },
    CAS_R2: {},
    CAS_DO: {
      idFromName: () => "id",
      get: () => ({ fetch: doFetch }),
    },
    doFetch,
    ...overrides,
  };
}

describe("CAS worker auth", () => {
  it("rejects missing internal token with 401", async () => {
    const res = await worker.fetch(
      new Request("https://cas/users/alice/cas/usage"),
      env() as never,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong internal token with 401", async () => {
    const res = await worker.fetch(
      new Request("https://cas/users/alice/cas/usage", {
        headers: { "X-Internal-Token": "nope" },
      }),
      env() as never,
    );
    expect(res.status).toBe(401);
  });
});

describe("CAS worker root-refs", () => {
  it("requires X-User-Id", async () => {
    const res = await worker.fetch(
      new Request("https://cas/_internal/root-refs", {
        method: "POST",
        headers: { "X-Internal-Token": TOKEN },
      }),
      env() as never,
    );
    expect(res.status).toBe(401);
  });

  it("forwards POST /_internal/root-refs to the Durable Object", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request("https://cas/_internal/root-refs", {
        method: "POST",
        headers: {
          "X-Internal-Token": TOKEN,
          "X-User-Id": "alice",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId: "apply:alice:doc:2", changes: { [hash]: 1 } }),
      }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    expect(bindings.doFetch).toHaveBeenCalled();
    const [url, init] = bindings.doFetch.mock.calls[0] as [string, { headers: Headers }];
    expect(new URL(url).pathname).toBe("/updateRootRefs");
    expect(init.headers.get("X-User-Id")).toBe("alice");
  });
});
