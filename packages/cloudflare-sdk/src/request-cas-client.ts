import {
  createCasBlobClient,
  createTenantCasClient,
} from "@unicas/tenant-client";
import type { CasBlobClient, HttpFetcher, TenantCasClient } from "@unicas/tenant-client";

export type RequestCasClient = TenantCasClient & CasBlobClient;

export interface RequestCasEnv {
  readonly CAS_SERVICE: HttpFetcher;
  readonly CAS_STACK_ID: string;
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
    if (env.CAS_STACK_ID.length === 0) throw new Error("CAS_STACK_ID is required for delegated CAS access");
    const cas = createTenantCasClient({
      baseUrl: "https://cas.internal",
      fetcher: env.CAS_SERVICE,
      stackId: env.CAS_STACK_ID,
      tenantId,
      getToken: async () => capability,
    });
    return Object.freeze({ ...cas, ...createCasBlobClient(cas) });
  }
  if (authKind === "legacy") return null;
  throw new Error("Missing private Doc auth context");
}