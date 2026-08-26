import { CasClient } from "@unidocs/cas-client";
import type { HttpFetcher } from "@unidocs/cas-client";

export interface RequestCasEnv {
  readonly CAS_SERVICE: HttpFetcher;
  readonly CAS_ACCESS_KEY?: string;
}

export function createRequestCasClient(
  env: RequestCasEnv,
  request: Request,
): CasClient | null {
  const authKind = request.headers.get("X-UniDocs-Auth-Context");
  const tenantId = request.headers.get("X-Tenant-Id");
  const sessionId = request.headers.get("X-Session-Id");
  if (!tenantId || !sessionId) throw new Error("Missing private Doc identity context");
  if (authKind === "capability") {
    const capability = request.headers.get("X-UniDocs-CAS-Capability");
    return capability
      ? new CasClient({
        fetcher: env.CAS_SERVICE,
        tenantId,
        sessionId,
        capability,
      })
      : null;
  }
  if (authKind === "legacy") {
    if (!env.CAS_ACCESS_KEY) throw new Error("Legacy CAS access key is unavailable");
    return new CasClient({
      fetcher: env.CAS_SERVICE,
      tenantId,
      accessKey: env.CAS_ACCESS_KEY,
    });
  }
  throw new Error("Missing private Doc auth context");
}