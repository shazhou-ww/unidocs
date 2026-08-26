/**
 * BFF boundary CSRF/origin protection.
 *
 * Every mutating `/admin` API request must (a) carry an Origin header whose
 * origin equals the configured public origin and (b) present the session's
 * CSRF token in `X-CSRF-Token`. Failure returns a BFF-local
 * `CSRF_ORIGIN_FAILED` (403) — this code is not part of the frozen
 * control-plane error set because it is an ingress-level rejection, not a
 * control-plane API error.
 */

export const CSRF_ORIGIN_FAILED = "CSRF_ORIGIN_FAILED";

export function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function checkSameOrigin(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}

export function checkCsrfToken(request: Request, expected: string): boolean {
  const provided = request.headers.get("X-CSRF-Token");
  if (!provided || provided.length === 0 || expected.length === 0) return false;
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < provided.length; i += 1) {
    difference |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}
