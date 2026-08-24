/**
 * UniDocs API Gateway
 *
 * Cloudflare entry point: wires the cloud-neutral routing logic in
 * `@unidocs/server-core`'s `createGatewayHandler` to Cloudflare-specific
 * bindings (KV registry, D1 doc index, CAS service binding).
 *
 * Registry (KV "unidocs-registry"):
 *   Key: "docType:{type}"  →  Value: "{ workerUrl: string }"
 *
 * Identity:
 *   Public userId comes from the URL path.
 *   Future Bearer tokens must bind to that userId.
 *
 * Internal auth:
 *   Gateway → doc worker / CAS worker: X-Internal-Token
 *   Gateway → CAS worker: X-User-Id from the URL path
 */

import { createGatewayHandler } from "@unidocs/server-core";
import { D1DocIndexQuery } from "@unidocs/cloudflare-sdk";
import { isPublicCasRoute } from "@unidocs/cas-server-common";

interface RegistryEntry {
  workerUrl: string;
}

interface Env {
  REGISTRY: KVNamespace;
  SNAPSHOTS_DB: D1Database;
  INTERNAL_TOKEN: string;
  CAS_SERVICE: Fetcher;
  [key: string]: unknown;
}

async function resolveWorkerUrl(env: Env, docType: string): Promise<string | null> {
  const entry = await env.REGISTRY.get<RegistryEntry>(`docType:${docType}`, "json");
  if (entry) return entry.workerUrl;
  const envKey = `${docType.toUpperCase()}_WORKER_URL`;
  const url = env[envKey] as string | undefined;
  return url || null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handle = createGatewayHandler({
      internalToken: env.INTERNAL_TOKEN,
      resolveWorkerUrl: (docType) => resolveWorkerUrl(env, docType),
      casFetcher: env.CAS_SERVICE,
      docIndex: new D1DocIndexQuery(env.SNAPSHOTS_DB),
      isPublicCasRoute,
    });
    return handle(request);
  },
};
