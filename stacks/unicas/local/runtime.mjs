import { startLocalRuntime } from "../../unidocs-cloudflare/local/runtime.mjs";

export function startLocalUnicasRuntime(options = {}) {
  return startLocalRuntime({
    ...options,
    docTypes: [],
    casMiddlewareOnly: true,
  });
}