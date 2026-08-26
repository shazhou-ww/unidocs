import { describe, expect, test, vi } from "vitest";
import { createRequestCasClient } from "../src/request-cas-client.js";

describe("createRequestCasClient", () => {
  test("uses only the delegated CAS Bearer on tenant-prefixed routes", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2])));
    const client = createRequestCasClient(
      { CAS_SERVICE: { fetch } },
      privateRequest({
        "X-UniDocs-Auth-Context": "capability",
        "X-UniDocs-CAS-Capability": "delegated-token",
        Authorization: "Bearer primary-doc-token",
      }),
    );
    await client!.read({ kind: "cas", hash: "a".repeat(64) });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://cas.internal/tenants/tenant-1/cas/nodes/${"a".repeat(64)}/content`);
    expect(init?.headers).toEqual({ Authorization: "Bearer delegated-token" });
    expect(JSON.stringify(init)).not.toContain("primary-doc-token");
  });

  test("does not construct a CAS client without delegated authority", () => {
    expect(createRequestCasClient(
      { CAS_SERVICE: { fetch: vi.fn() } },
      privateRequest({ "X-UniDocs-Auth-Context": "capability" }),
    )).toBeNull();
  });

  test("keeps legacy shared headers on the quarantined legacy path", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array()));
    const client = createRequestCasClient(
      { CAS_SERVICE: { fetch }, CAS_ACCESS_KEY: "legacy-key" },
      privateRequest({ "X-UniDocs-Auth-Context": "legacy" }),
    );
    await client!.read({ kind: "cas", hash: "b".repeat(64) });
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      "X-Internal-Token": "legacy-key",
      "X-Tenant-Id": "tenant-1",
    });
  });
});

function privateRequest(extraHeaders: Record<string, string>): Request {
  return new Request("https://editor.internal/_internal/query", {
    headers: {
      "X-Tenant-Id": "tenant-1",
      "X-Session-Id": "session-1",
      ...extraHeaders,
    },
  });
}