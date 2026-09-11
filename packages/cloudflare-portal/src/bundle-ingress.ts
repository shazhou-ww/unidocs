import { IMMUTABLE_BUNDLE_CACHE_CONTROL, validateBundlePath } from "@unidocs/portal-service";

const contentTypes: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function headers(contentType: string | undefined, sha256: string | undefined, contentSecurityPolicy: string) {
  const result = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": IMMUTABLE_BUNDLE_CACHE_CONTROL,
    "Content-Security-Policy": contentSecurityPolicy,
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType) result.set("Content-Type", contentType);
  if (sha256 && /^[0-9a-f]{64}$/.test(sha256)) result.set("ETag", `"sha256-${sha256}"`);
  return result;
}

export async function serveBundleObject(request: Request, bucket: R2Bucket, portalOrigin = "https://portal.invalid"): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Max-Age": "86400" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  const url = new URL(request.url);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 404 });
  }
  const match = /^\/(type-card-bundles|view-bundles)\/((?:tb|vb)_[0-9a-f]{64})\/(.+)$/.exec(path);
  if (!match) return new Response(null, { status: 404 });
  const kind = match[1];
  if (kind === "type-card-bundles" && !match[2].startsWith("tb_") || kind === "view-bundles" && !match[2].startsWith("vb_")) return new Response(null, { status: 404 });
  let relativePath: string;
  try {
    relativePath = validateBundlePath(match[3]);
  } catch {
    return new Response(null, { status: 404 });
  }
  const extensionAt = relativePath.lastIndexOf(".");
  const extension = extensionAt === -1 ? "" : relativePath.slice(extensionAt).toLowerCase();
  const manifestPath = kind === "type-card-bundles" ? "unidocs-type-card.json" : "unidocs-view.json";
  const allowedExtensions = kind === "type-card-bundles"
    ? new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"])
    : new Set([".html", ".css", ".js", ".mjs", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2"]);
  const contentType = relativePath === manifestPath ? contentTypes[".json"] : allowedExtensions.has(extension) ? contentTypes[extension] : undefined;
  if (!contentType) return new Response(null, { status: 404 });
  let viewFrameAncestor: string;
  try {
    const parsedPortalOrigin = new URL(portalOrigin);
    if (parsedPortalOrigin.protocol !== "https:" || parsedPortalOrigin.origin !== portalOrigin) throw new Error();
    viewFrameAncestor = parsedPortalOrigin.origin;
  } catch {
    return new Response(null, { status: 404 });
  }
  const contentSecurityPolicy = kind === "view-bundles"
    ? `default-src 'none'; script-src ${url.origin}/${kind}/${match[2]}/; style-src ${url.origin}/${kind}/${match[2]}/; img-src ${url.origin}/${kind}/${match[2]}/ data: blob:; font-src ${url.origin}/${kind}/${match[2]}/; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${viewFrameAncestor}; sandbox allow-scripts`
    : "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox";
  const object = await bucket.get(`${kind}/${match[2]}/${relativePath}`);
  if (!object) return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } });
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: headers(contentType, object.customMetadata?.sha256, contentSecurityPolicy),
  });
}