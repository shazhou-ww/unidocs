import { describe, expect, it } from "vitest";
import { loadTenantSession } from "../src/session/bootstrap.js";

describe("loadTenantSession", () => {
  it("returns the tenant identity when signed in", async () => {
    const session = await loadTenantSession(async () => Response.json({ tenantId: "t-local", principalId: "user-local" }));
    expect(session).toEqual({ kind: "signed-in", tenantId: "t-local", principalId: "user-local" });
  });

  it("reports signed-out on 401", async () => {
    const session = await loadTenantSession(async () => Response.json({ error: { code: "unauthorized", message: "x", requestId: "r" } }, { status: 401 }));
    expect(session).toEqual({ kind: "signed-out" });
  });

  it("requests the session with credentials", async () => {
    let seen: RequestInit | undefined;
    await loadTenantSession(async (_input, init) => { seen = init; return Response.json({ tenantId: "t", principalId: "p" }); });
    expect(seen?.credentials).toBe("include");
  });

  it("throws on an unexpected response rather than guessing a tenant", async () => {
    await expect(loadTenantSession(async () => Response.json({ tenantId: 42 }))).rejects.toThrow();
  });
});
