import { IMMUTABLE_BUNDLE_CACHE_CONTROL, validateBundlePath } from "@unidocs/portal-service";

const contentTypes: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function headers(contentType?: string, sha256?: string) {
  const result = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": IMMUTABLE_BUNDLE_CACHE_CONTROL,
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType) result.set("Content-Type", contentType);
  if (sha256 && /^[0-9a-f]{64}$/.test(sha256)) result.set("ETag", `"sha256-${sha256}"`);
  return result;
}

export async function serveBundleObject(request: Request, bucket: R2Bucket): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Max-Age": "86400" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  const url = new URL(request.url);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 404 });
  }
  const match = /^\/type-card-bundles\/(tb_[0-9a-f]{64})\/(.+)$/.exec(path);
  if (!match) return new Response(null, { status: 404 });
  let relativePath: string;
  try {
    relativePath = validateBundlePath(match[2]);
  } catch {
    return new Response(null, { status: 404 });
  }
  const extensionAt = relativePath.lastIndexOf(".");
  const extension = extensionAt === -1 ? "" : relativePath.slice(extensionAt).toLowerCase();
  const contentType = relativePath === "unidocs-type-card.json" ? contentTypes[".json"] : contentTypes[extension];
  if (!contentType || relativePath !== "unidocs-type-card.json" && extension === ".json") return new Response(null, { status: 404 });
  const object = await bucket.get(`type-card-bundles/${match[1]}/${relativePath}`);
  if (!object) return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } });
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: headers(contentType, object.customMetadata?.sha256),
  });
}