import { describe, it, expect, vi } from "vitest";
import worker from "../src/worker";

const hash = "a".repeat(64);

function env(fetchImpl?: (request: Request) => Promise<Response>) {
  const casFetch = vi.fn(fetchImpl ?? (async () => new Response("ok")));
  return {
    GATEWAY_DB: {},
    DOC_SERVICES_JSON: "{}",
    CAS_ACCESS_KEY: "cas-key",
    INSECURE_PATH_IDENTITY: "true",
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
    expect(new URL(forwarded.url).pathname).toBe(`/tenants/alice/cas/nodes/${hash}`);
    expect(forwarded.headers.get("X-Internal-Token")).toBe("cas-key");
    expect(forwarded.headers.get("X-Tenant-Id")).toBe("alice");
    expect(forwarded.headers.get("X-User-Id")).toBeNull();
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
