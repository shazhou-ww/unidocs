export interface MarkdownDiscoveryBindings {
  readonly DOC_SERVICE_ID?: string;
  readonly DOC_STORAGE_IDENTITY?: string;
  readonly DOC_CAPABILITY_AUDIENCE?: string;
}

export function markdownDiscovery(request: Request, env: MarkdownDiscoveryBindings): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== "/.well-known/unidocs-doctype" && path !== "/health" && path !== "/editor/") return null;
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" };
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  if (path === "/editor/") return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "embedded_editor_unavailable" }), { status: 501, headers });
  const configured = [env.DOC_SERVICE_ID, env.DOC_STORAGE_IDENTITY, env.DOC_CAPABILITY_AUDIENCE].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value));
  if (!configured) return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "discovery_not_configured" }), { status: 503, headers });
  const body = path === "/health" ? { status: "ok", checks: "configuration-only" } : {
    docType: "markdown", displayName: "Markdown", description: "Markdown text documents",
    serviceId: env.DOC_SERVICE_ID, storageIdentity: env.DOC_STORAGE_IDENTITY, audience: env.DOC_CAPABILITY_AUDIENCE,
    protocol: "unidocs-doctype/1", editorProtocol: null, formats: [".md", ".markdown"], capabilities: { preview: false, edit: false },
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { headers });
}

export function markdownApiRequest(request: Request): Request {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return request;
  url.pathname = url.pathname.slice(4);
  return new Request(url, request);
}