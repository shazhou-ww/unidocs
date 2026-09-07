import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDocuments } from "../src/ui/api.js";
import { loadSession, saveSession } from "../src/ui/oauth.js";
import { accessTokenSession } from "./session-fixture.js";

vi.mock("../src/ui/config.js", () => ({ API_BASE: "https://gateway.test", OAUTH_BASE: "https://gateway.test/oauth", CLIENT_NAME: "test", REDIRECT_URI: "https://gateway.test/callback" }));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem("unidocs.oauth.clientId", "client"); accessTokenSession("alice"); saveSession({ ...loadSession()!, expiresAt: 1 }); });
afterEach(() => vi.unstubAllGlobals());

describe("parallel directory session refresh", () => {
  it("rotates a refresh token once for simultaneous type requests", async () => {
    const token = loadSession()!.accessToken;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => url.endsWith("/token")
      ? Response.json({ access_token: token, refresh_token: "rotated", expires_in: 3600 })
      : Response.json({ success: true, data: [], count: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all(["markdown", "psd", "docx"].map(type => listDocuments("alice", type)));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/token"))).toHaveLength(1);
    expect(loadSession()!.refreshToken).toBe("rotated");
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/docs/"))).toHaveLength(3);
  });

  it("reports authentication failure and clears an invalid grant instead of directory errors", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.allSettled(["markdown", "psd", "docx"].map(type => listDocuments("alice", type)));
    expect(results.every(result => result.status === "rejected" && result.reason.status === 401)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadSession()).toBeNull();
  });

  it("preserves the session on transient token-server failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Temporary failure", { status: 503 })));
    await expect(listDocuments("alice", "markdown")).rejects.toThrow("token refresh failed");
    expect(loadSession()).not.toBeNull();
  });
});