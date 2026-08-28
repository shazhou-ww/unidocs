import {
  createCasBlobClient,
  createLegacyTenantCasClient,
  createTenantCasClient,
} from "@unicas/client";
import type { CasBlobClient, HttpFetcher, TenantCasClient } from "@unicas/client";

export type RequestCasClient = TenantCasClient & CasBlobClient;

export interface RequestCasEnv {
  readonly CAS_SERVICE: HttpFetcher;
  readonly CAS_ACCESS_KEY?: string;
  /** Stack namespace for canonical /stacks routes (stack mode). */
  readonly CAS_STACK_ID?: string;
}

export function createRequestCasClient(
  env: RequestCasEnv,
  request: Request,
): RequestCasClient | null {
  const authKind = request.headers.get("X-UniDocs-Auth-Context");
  const tenantId = request.headers.get("X-Tenant-Id");
  const sessionId = request.headers.get("X-Session-Id");
  if (!tenantId || !sessionId) throw new Error("Missing private Doc identity context");
  if (authKind === "capability") {
    const capability = request.headers.get("X-UniDocs-CAS-Capability");
    if (!capability) return null;
    const cas = env.CAS_STACK_ID === undefined
      ? createLegacyTenantCasClient({
        fetcher: env.CAS_SERVICE,
        tenantId,
        getToken: async () => capability,
      })
      : createTenantCasClient({
        baseUrl: "https://cas.internal",
        fetcher: env.CAS_SERVICE,
        stackId: env.CAS_STACK_ID,
        tenantId,
        getToken: async () => capability,
      });
    return Object.freeze({ ...cas, ...createCasBlobClient(cas) });
  }
  if (authKind === "legacy") {
    if (!env.CAS_ACCESS_KEY) throw new Error("Legacy CAS access key is unavailable");
    const cas = createLegacyTenantCasClient({
      fetcher: env.CAS_SERVICE,
      tenantId,
      accessKey: env.CAS_ACCESS_KEY,
    });
    return Object.freeze({ ...cas, ...createCasBlobClient(cas) });
  }
  throw new Error("Missing private Doc auth context");
}