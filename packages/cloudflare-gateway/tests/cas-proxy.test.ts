import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker";

const hash = "a".repeat(64);

function env(fetchImpl?: (request: Request) => Promise<Response>) {
  const casFetch = vi.fn(fetchImpl ?? (async () => new Response("ok")));
  return {
    REGISTRY: { get: async () => null },
    SNAPSHOTS_DB: {},
    INTERNAL_TOKEN: "gw-token",
    CAS_SERVICE: { fetch: casFetch },
    casFetch,
  };
}

describe("Gateway CAS proxy", () => {
  it("forwards allowlisted public CAS routes with internal headers", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request(`https://gw/users/alice/cas/nodes/${hash}`, { method: "POST" }),
      bindings as never,
    );
    expect(res.ok).toBe(true);
    expect(bindings.casFetch).toHaveBeenCalledTimes(1);
    const forwarded = bindings.casFetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("X-Internal-Token")).toBe("gw-token");
    expect(forwarded.headers.get("X-User-Id")).toBe("alice");
  });

  it("does not proxy root-refs", async () => {
    const bindings = env();
    const res = await worker.fetch(
      new Request("https://gw/users/alice/cas/root-refs", { method: "POST" }),
      bindings as never,
    );
    expect(res.status).toBe(404);
    expect(bindings.casFetch).not.toHaveBeenCalled();
  });
});
