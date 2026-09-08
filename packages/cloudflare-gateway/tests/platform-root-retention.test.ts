import { describe, expect, it, vi } from "vitest";
import { createPlatformRootRetention } from "../src/platform-root-retention.js";

describe("platform root retention", () => {
  it("retains one immutable version root with a short-lived platform capability", async () => {
    const fetch = vi.fn(async (input: string | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/stacks/stack-1/tenants/tenant-1/root-refs");
      expect(request.headers.get("authorization")).toBe("Bearer platform-token");
      expect(await request.json()).toEqual({ requestId: "platform-commit-request-root", changes: { ["a".repeat(64)]: 1 } });
      return Response.json({ success: true, idempotent: false, revision: 1 });
    });
    const getAuthorization = vi.fn(async () => "Bearer platform-token");
    const roots = createPlatformRootRetention({ stackId: "stack-1", tenantId: "tenant-1", fetcher: { fetch }, getAuthorization });

    await expect(roots.retainRoot({ requestId: "platform-commit-request-root", stateHash: "a".repeat(64) })).resolves.toBeUndefined();
    expect(getAuthorization).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects malformed credentials and roots before accepting a retention result", async () => {
    const fetch = vi.fn(async () => Response.json({ success: true }));
    const invalid = createPlatformRootRetention({ stackId: "stack-1", tenantId: "tenant-1", fetcher: { fetch },
      getAuthorization: async () => "token-without-scheme" });
    await expect(invalid.retainRoot({ requestId: "request-1", stateHash: "a".repeat(64) })).rejects.toThrow("authorization");
    await expect(invalid.retainRoot({ requestId: "request-1", stateHash: "bad" })).rejects.toThrow("Invalid platform root");
  });
});