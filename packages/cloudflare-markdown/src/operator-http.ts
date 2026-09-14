/**
 * HTTP pieces shared by the Operator probe endpoint and the Operator webhook,
 * so the body bounds, JSON strictness and key rules cannot drift apart.
 */
import { parseTree, type Node, type ParseError } from "jsonc-parser";

export function operatorHeaders(extra: Record<string, string> = {}) {
  return { "Cache-Control": "no-store, no-transform", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...extra };
}

/** The HMAC key shared with the Portal: exactly 64 lowercase hex characters, or null. */
export function operatorKeyBytes(value: string | undefined): Uint8Array | null {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
}

/** The configured document type, or null when it is missing or not a Portal document type id. */
export function operatorDocumentType(value: string | undefined): string | null {
  return value && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

/**
 * Reads an `application/json` body of at most `maxBytes` and parses it
 * strictly: UTF-8, no comments or trailing commas, no duplicate keys, depth at
 * most 16. Returns the raw `bytes` alongside the parsed `value`, because a
 * signature must be checked over exactly the bytes that were sent. Any failure
 * is `null`; an oversized stream is cancelled at the first chunk over the bound.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<{ bytes: Uint8Array; value: unknown } | null> {
  if (!request.body || request.headers.has("content-encoding") || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  const reader = request.body.getReader();
  const buffer = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > buffer.byteLength) throw new Error();
      buffer.set(chunk.value, size - chunk.value.byteLength);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = buffer.slice(0, size);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
    if (!root || errors.length) return null;
    const inspect = (node: Node, depth: number): void => {
      if (depth > 16) throw new Error();
      if (node.type === "object") {
        const keys = new Set<string>();
        for (const property of node.children ?? []) {
          const key: unknown = property.children?.[0]?.value;
          if (typeof key !== "string" || keys.has(key)) throw new Error();
          keys.add(key);
        }
      }
      for (const child of node.children ?? []) inspect(child, depth + 1);
    };
    inspect(root, 0);
    return { bytes, value: JSON.parse(text) };
  } catch {
    return null;
  }
}
