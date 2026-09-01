import type {
  GatewayOAuthHashPort,
  GatewayOAuthRandomPort,
} from "./ports.js";

export const systemGatewayOAuthRandom: GatewayOAuthRandomPort = Object.freeze({
  opaque(byteLength: number): string {
    if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 128) {
      throw new TypeError("OAuth random byte length must be an integer from 16 to 128");
    }
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  },
});

export const systemGatewayOAuthHash: GatewayOAuthHashPort = Object.freeze({
  async sha256Base64Url(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return base64Url(new Uint8Array(digest));
  },
});

function base64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!;
    const hasB = offset + 1 < bytes.length;
    const hasC = offset + 2 < bytes.length;
    const b = hasB ? bytes[offset + 1]! : 0;
    const c = hasC ? bytes[offset + 2]! : 0;
    const value = (a << 16) | (b << 8) | c;
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += hasB ? alphabet[(value >>> 6) & 63] : "=";
    output += hasC ? alphabet[value & 63] : "=";
  }
  return output.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
