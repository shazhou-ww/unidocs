/** Test fixture: writes a fake OAuth session for the given tenant. */
export function accessTokenSession(tenantId: string): void {
  const header = btoa(JSON.stringify({ alg: "ES256", typ: "unidocs-cap+jwt" }));
  const payload = btoa(JSON.stringify({ ver: 1, iss: "issuer", sub: "user", aud: "aud", tenantId, permissions: [] }));
  sessionStorage.setItem("unidocs.oauth.session", JSON.stringify({
    accessToken: `${header}.${payload}.signature`,
    refreshToken: "rt",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "cas:read cas:write cas:manage",
    tenantId,
  }));
}
