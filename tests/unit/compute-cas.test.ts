import { describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createComputeCas } from "../../packages/cloudflare-markdown/src/compute-cas.js";
import { CapabilityTokenType, casReadPermission, casWritePermission } from "../../packages/service-auth/src/index.js";
import { encodeSValue, createSBlob } from "../../packages/svalue-codec/src/index.js";
import { SValueContentType } from "../../packages/protocol/src/index.js";
import { computeNodeDigest, encodeHeader, hashToHex } from "../../unicas-packages/codec/src/index.js";

const pair = await generateKeyPair("ES256", { extractable: true });
const jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: "cas-1", alg: "ES256" }] };
const invocation = { requestId: "req", actorId: "actor", tenantId: "tenant", docId: "doc", docType: "markdown" };
const content = encodeSValue({ content: "# 中文\n\n保存状态" });
const hash = hashToHex(await computeNodeDigest(encodeHeader(content.length, SValueContentType, 0), SValueContentType, [], content));

async function token(permissions = [casReadPermission("tenant")], overrides = {}) {
  return new SignJWT({ ver: 1, tenantId: "tenant", permissions, ...overrides })
    .setProtectedHeader({ alg: "ES256", kid: "cas-1", typ: CapabilityTokenType })
    .setIssuer("https://issuer.example").setAudience("https://cas.example/stacks/test")
    .setSubject("doc:markdown").setIssuedAt(1000).setNotBefore(1000).setExpirationTime(1120).setJti("cas-token")
    .sign(pair.privateKey);
}

function setup(options: { metadata?: object; bytes?: Uint8Array; now?: () => number; redirect?: boolean } = {}) {
  const fetcher = { fetch: vi.fn(async (input: string | Request) => {
    const request = new Request(input);
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    if (options.redirect) return new Response(null, { status: 302, headers: { location: "https://other.example" } });
    if (new URL(request.url).pathname.endsWith("/content")) return new Response(new Uint8Array(options.bytes ?? content));
    return Response.json({ metadata: { hash, size: content.length, contentType: SValueContentType, refs: [], ...options.metadata } });
  }) };
  return { fetcher, cas: createComputeCas({ baseUrl: "https://cas.example", stackId: "test", issuer: "https://issuer.example",
    audience: "https://cas.example/stacks/test", jwks, fetcher, now: options.now ?? (() => 1000) }) };
}

describe("compute CAS facade", () => {
  it("reads and verifies a canonical state node using only authenticated GETs", async () => {
    const { cas, fetcher } = setup();
    const authorization = `Bearer ${await token()}`;
    await expect(cas.loadSnapshot(createSBlob(hash), { authorization, mode: "ro", invocation }))
      .resolves.toEqual({ content: "# 中文\n\n保存状态" });
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
    for (const [input] of fetcher.fetch.mock.calls) expect(new Request(input).headers.get("authorization")).toBe(authorization);
    expect(Object.keys(cas).sort()).toEqual(["authorizeCas", "loadSnapshot"]);
  });

  it("enforces exact RO/RW permissions and tenant identity", async () => {
    const { cas, fetcher } = setup();
    const ro = { authorization: `Bearer ${await token()}`, mode: "ro" as const, invocation };
    const rw = { ...ro, authorization: `Bearer ${await token([casReadPermission("tenant"), casWritePermission("tenant")])}`, mode: "rw" as const };
    expect(await cas.authorizeCas(ro)).toBe(true);
    expect(await cas.authorizeCas(rw)).toBe(true);
    expect(await cas.authorizeCas({ ...ro, mode: "rw" })).toBe(false);
    expect(await cas.authorizeCas({ ...rw, mode: "ro" })).toBe(false);
    expect(await cas.authorizeCas({ ...ro, invocation: { ...invocation, tenantId: "other" } })).toBe(false);
    await expect(cas.loadSnapshot(createSBlob(hash), rw)).rejects.toThrow();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it("revalidates expired credentials before reading", async () => {
    let now = 1000;
    const { cas, fetcher } = setup({ now: () => now });
    const access = { authorization: `Bearer ${await token()}`, mode: "ro" as const, invocation };
    expect(await cas.authorizeCas(access)).toBe(true);
    now = 1120;
    await expect(cas.loadSnapshot(createSBlob(hash), access)).rejects.toThrow();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { bytes: new Uint8Array(content.length).fill(1) }, { bytes: content.slice(1) },
    { bytes: new Uint8Array(content.length + 1) }, { metadata: { size: 2_000_000 } },
    { metadata: { refs: [hash] } }, { metadata: { contentType: "application/json" } }, { redirect: true },
  ])("rejects damaged, oversized, wrong-kind or redirected snapshots: %j", async (options) => {
    const { cas } = setup(options);
    await expect(cas.loadSnapshot(createSBlob(hash), { authorization: `Bearer ${await token()}`, mode: "ro", invocation })).rejects.toThrow();
  });
});