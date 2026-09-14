/**
 * HMAC signing/verification for the portal -> markdown-operator webhook.
 *
 * The operator worker has a public URL (it is not reachable only through a
 * Cloudflare service binding), so a shared-secret signature over the webhook
 * body is the only thing that stops an outside caller from forging operator
 * events. See global-constraints.md R11 for the wire format.
 */

const DOMAIN = "unidocs-operator-webhook-v1\n";
const encoder = new TextEncoder();

export const OperatorWebhookTimestampHeader = "x-unidocs-webhook-timestamp";
export const OperatorWebhookSignatureHeader = "x-unidocs-webhook-signature";

const WINDOW_SECONDS = 300;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacKey(keyBytes: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (keyBytes.byteLength < 32) throw new TypeError("Operator webhook keys require at least 32 bytes");
  return crypto.subtle.importKey("raw", arrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function signatureMessage(timestamp: string, body: Uint8Array): Promise<Uint8Array> {
  const digest = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer(body))));
  return encoder.encode(DOMAIN + timestamp + "\n" + digest);
}

export async function signOperatorWebhook(
  body: Uint8Array,
  keyBytes: Uint8Array,
  issuedAt: Date,
): Promise<{ timestamp: string; signature: string }> {
  if (!Number.isFinite(issuedAt.getTime())) throw new TypeError("issuedAt must be a valid Date");
  const timestamp = String(Math.floor(issuedAt.getTime() / 1000));
  const key = await hmacKey(keyBytes, "sign");
  const message = await signatureMessage(timestamp, body);
  const signature = await crypto.subtle.sign("HMAC", key, arrayBuffer(message));
  return { timestamp, signature: base64Url(new Uint8Array(signature)) };
}

export async function verifyOperatorWebhook(
  body: Uint8Array,
  headers: { timestamp: string | null; signature: string | null },
  keyBytes: Uint8Array,
  now: Date,
): Promise<boolean> {
  try {
    const { timestamp, signature } = headers;
    if (timestamp === null || signature === null) return false;
    if (!/^(0|[1-9][0-9]*)$/.test(timestamp)) return false;
    const timestampSeconds = Number(timestamp);
    if (!Number.isSafeInteger(timestampSeconds)) return false;
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    if (!Number.isFinite(now.getTime())) return false;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > WINDOW_SECONDS) return false;
    const key = await hmacKey(keyBytes, "verify");
    const message = await signatureMessage(timestamp, body);
    const signatureBytes = base64UrlToBytes(signature);
    return await crypto.subtle.verify("HMAC", key, arrayBuffer(signatureBytes), arrayBuffer(message));
  } catch {
    return false;
  }
}
