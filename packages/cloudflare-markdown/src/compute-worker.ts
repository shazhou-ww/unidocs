import { createMarkdownEditorHandler } from "@unidocs/doctype-markdown";
import { importPlatformHmacKey } from "@unidocs/service-auth";
import { SValueContentType } from "@unidocs/protocol";
import { encodeSValue } from "@unidocs/svalue-codec";
import { createPlatformNonceStore } from "./platform-nonces.js";
import { createComputeCas } from "./compute-cas.js";
export { PlatformNonces } from "./platform-nonces.js";

type ComputeEnv = Cloudflare.Env & { readonly PLATFORM_HMAC_KEYS?: string };
const handlers = new WeakMap<ComputeEnv, ReturnType<typeof createMarkdownEditorHandler>>();

async function createHandler(env: ComputeEnv) {
  for (const value of [env.COMPUTE_ORIGIN, env.CAS_ORIGIN, env.CAS_ISSUER, env.CAS_JWKS_URL]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.endsWith(".invalid") || url.username || url.password) throw new Error("Compute configuration incomplete");
  }
  const configured: unknown = JSON.parse(env.PLATFORM_HMAC_KEYS ?? "null");
  if (configured === null || typeof configured !== "object" || Array.isArray(configured)) throw new Error("Missing HMAC key map");
  const entries = Object.entries(configured);
  if (entries.length === 0 || entries.length > 2) throw new Error("Invalid HMAC key overlap");
  const keys = await Promise.all(entries.map(async ([keyId, secret]) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId) || typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Invalid HMAC key entry");
    const bytes = Uint8Array.from(secret.match(/../g)!, (pair) => parseInt(pair, 16));
    return { keyId, platformId: env.PLATFORM_ID, environment: env.COMPUTE_ENVIRONMENT,
      serviceId: env.COMPUTE_SERVICE_ID, role: "editor" as const, key: await importPlatformHmacKey(bytes) };
  }));
  const cas = createComputeCas({ baseUrl: env.CAS_ORIGIN, stackId: env.CAS_STACK_ID,
    issuer: env.CAS_ISSUER, audience: env.CAS_AUDIENCE, jwks: new URL(env.CAS_JWKS_URL),
    fetcher: { fetch: (input, init) => env.CAS_SERVICE.fetch(input, init) },
  });
  return createMarkdownEditorHandler({ origin: env.COMPUTE_ORIGIN, platformId: env.PLATFORM_ID,
    environment: env.COMPUTE_ENVIRONMENT, serviceId: env.COMPUTE_SERVICE_ID, keys: () => keys,
    nonces: createPlatformNonceStore(env.PLATFORM_NONCES), authorizeCas: cas.authorizeCas,
    async loadSnapshot(blob, access) {
      try {
        return await cas.loadSnapshot(blob, access);
      } catch (error) {
        console.error(JSON.stringify({ event: "markdown_snapshot_load_failed",
          error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError" } }));
        throw error;
      }
    },
  });
}

export default {
  async fetch(request: Request, env: ComputeEnv): Promise<Response> {
    try {
      let handler = handlers.get(env);
      if (!handler) {
        const created = await createHandler(env);
        handler = handlers.get(env) ?? created;
        handlers.set(env, handler);
      }
      return await handler(request);
    } catch {
      return new Response(new Uint8Array(encodeSValue({ success: false, error: { code: "unavailable", message: "unavailable" } })), {
        status: 503, headers: { "content-type": SValueContentType, "cache-control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<ComputeEnv>;