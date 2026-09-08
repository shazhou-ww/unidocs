import { createTenantCasClient } from "@unicas/tenant-client";
import type { HttpFetcher } from "@unicas/tenant-client";
import { computeNodeDigest, encodeHeader, hashToHex, validateHash } from "@unicas/codec";
import { CapabilityAlgorithm, CapabilityError, CapabilityVerifier, casReadPermission, casWritePermission } from "@unidocs/service-auth";
import type { CapabilityVerifierConfig } from "@unidocs/service-auth";
import { SValueContentType } from "@unidocs/protocol";
import type { SBlob } from "@unidocs/protocol";
import { decodeSValue } from "@unidocs/svalue-codec";
import type { MarkdownCasAccess } from "@unidocs/doctype-markdown";

export interface ComputeCasOptions {
  readonly baseUrl: string;
  readonly stackId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: CapabilityVerifierConfig["jwks"];
  readonly fetcher: HttpFetcher;
  readonly now?: () => number;
}

export function createComputeCas(options: ComputeCasOptions) {
  const origin = new URL(options.baseUrl);
  if (origin.protocol !== "https:" || origin.origin !== options.baseUrl) throw new TypeError("CAS requires an exact HTTPS origin");
  const verifier = new CapabilityVerifier({
    issuer: options.issuer, audience: options.audience, jwks: options.jwks, algorithm: CapabilityAlgorithm,
    allowedPermissionKinds: ["cas:read", "cas:write"], allowedSubjects: ["doc:markdown"],
    maximumLifetimeSeconds: 300, clockSkewSeconds: 0, now: options.now,
  });
  const authorizeCas = async (access: MarkdownCasAccess): Promise<boolean> => {
    if (!/^Bearer [A-Za-z0-9_.-]+$/.test(access.authorization)) return false;
    try {
      const { claims } = await verifier.verify(access.authorization.slice(7));
      if (claims.tenantId !== access.invocation.tenantId || claims.sessionId !== undefined) return false;
      const expected = access.mode === "ro" ? [casReadPermission(claims.tenantId)]
        : [casReadPermission(claims.tenantId), casWritePermission(claims.tenantId)];
      return claims.permissions.length === expected.length && expected.every((permission) => claims.permissions.includes(permission));
    } catch (error) {
      if (error instanceof CapabilityError) return false;
      throw error;
    }
  };
  return {
    authorizeCas,
    async loadSnapshot(blob: SBlob, access: MarkdownCasAccess): Promise<unknown> {
      validateHash(blob.hash);
      if (access.mode !== "ro" || !await authorizeCas(access)) throw new Error("CAS access denied");
      const client = createTenantCasClient({
        baseUrl: options.baseUrl, stackId: options.stackId, tenantId: access.invocation.tenantId,
        getToken: async () => {
          if (!await authorizeCas(access)) throw new Error("CAS access expired");
          return access.authorization.slice(7);
        },
        fetcher: { async fetch(input, init) {
          const request = new Request(input, { ...init, redirect: "manual" });
          const url = new URL(request.url);
          if (request.method !== "GET" || url.origin !== options.baseUrl) throw new Error("CAS read-only boundary");
          const result = await options.fetcher.fetch(request);
          if (result.status >= 300 && result.status < 400) throw new Error("CAS redirects forbidden");
          const maximum = url.pathname.endsWith("/content") ? 1_048_576 : 16_384;
          return boundedResponse(result, maximum);
        } },
      });
      const signal = AbortSignal.timeout(10_000);
      const metadata = await client.readMetadata(blob.hash, { signal });
      if (metadata.hash !== blob.hash || metadata.contentType !== SValueContentType || metadata.refs.length !== 0
        || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > 1_048_576) {
        throw new Error("Invalid Markdown snapshot metadata");
      }
      const reader = (await client.readContent(blob.hash, undefined, { signal })).getReader();
      const bytes = new Uint8Array(metadata.size);
      let offset = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (offset + chunk.value.length > bytes.length) {
            await reader.cancel();
            throw new Error("Snapshot size mismatch");
          }
          bytes.set(chunk.value, offset);
          offset += chunk.value.length;
        }
      } finally { reader.releaseLock(); }
      if (offset !== bytes.length) throw new Error("Snapshot size mismatch");
      const header = encodeHeader(bytes.length, SValueContentType, 0);
      if (hashToHex(await computeNodeDigest(header, SValueContentType, [], bytes)) !== blob.hash) throw new Error("Snapshot integrity mismatch");
      return decodeSValue(bytes);
    },
  };
}

function boundedResponse(response: Response, maximum: number): Response {
  if (!response.body) return response;
  let received = 0;
  const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maximum) throw new Error("CAS response exceeds limit");
      controller.enqueue(chunk);
    },
  }));
  return new Response(limited, { status: response.status, headers: response.headers });
}