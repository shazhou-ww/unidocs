import { boundedBytes, parseStrictJson } from "@unidocs/portal-service";

export type BoundedJsonRequest =
  | { readonly ok: true; readonly request: Request; readonly body: unknown }
  /**
   * `not_json`: the declared content type is not JSON, or the body is encoded.
   * `invalid`: the body is missing, larger than the limit, malformed, or repeats a key.
   * Each adapter turns these into its own error response and message.
   */
  | { readonly ok: false; readonly reason: "not_json" | "invalid" };

/**
 * Reads a JSON request body under a byte limit and parses it strictly, before
 * oRPC's codec sees it: the codec would buffer a body of any size, and
 * JSON.parse silently keeps the last of two duplicate keys. On success the
 * returned Request carries the exact bytes that were checked.
 */
export async function readBoundedJsonRequest(request: Request, maxBytes: number): Promise<BoundedJsonRequest> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) {
    return { ok: false, reason: "not_json" };
  }
  try {
    if (!request.body) throw new TypeError("Missing request body");
    const content = new Uint8Array(maxBytes);
    let length = 0;
    for await (const chunk of boundedBytes(request.body, content.length)) { content.set(chunk, length); length += chunk.byteLength; }
    const body = parseStrictJson(content.subarray(0, length));
    return { ok: true, body, request: new Request(request.url, { method: request.method, headers: request.headers, body: content.slice(0, length) }) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
