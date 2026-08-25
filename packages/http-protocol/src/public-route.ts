/**
 * Gateway allowlist: public CAS methods the Gateway may proxy.
 * Internal `/_internal/root-refs` is never public.
 */
export function isPublicCasRoute(method: string, pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "users" || parts[2] !== "cas") return false;

  if (parts.length === 4 && parts[3] === "usage") return method === "GET";
  if (parts.length === 5 && parts[3] === "nodes") return method === "POST";
  if (parts.length === 6 && parts[3] === "nodes") {
    if (parts[5] === "content" || parts[5] === "metadata") return method === "GET";
    if (parts[5] === "lease") return method === "POST";
  }
  return false;
}
