import { DocumentTypeSchema, ExternalEtagSchema } from "@unidocs/protocol-admin-portal";
import { canonicalJson } from "../identity.js";

const REQUEST_DOMAIN = "unidocs-operator-probe-request-v1\n";
const RECEIPT_DOMAIN = "unidocs-operator-probe-receipt-v1\n";
const encoder = new TextEncoder();

export interface OperatorProbeRequestBody {
  readonly protocol: "unidocs-operator-probe-request/v1";
  readonly challenge: string;
  readonly declaredOperatorId: string;
  readonly documentType: string;
  readonly configEtag: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface OperatorProbeReceipt {
  readonly protocol: "unidocs-operator-probe-receipt/v1";
  readonly challenge: string;
  readonly declaredOperatorId: string;
  readonly documentType: string;
  readonly configEtag: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export class OperatorProbeError extends Error {
  constructor() {
    super("Operator probe proof is invalid or expired");
    this.name = "OperatorProbeError";
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function signatureBytes(signature: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new OperatorProbeError();
  try {
    const binary = atob(signature.replaceAll("-", "+").replaceAll("_", "/") + "=");
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new OperatorProbeError();
  }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacKey(keyBytes: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (keyBytes.byteLength < 32) throw new OperatorProbeError();
  return crypto.subtle.importKey("raw", arrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function sign(domain: string, body: object, keyBytes: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(keyBytes, "sign"), encoder.encode(domain + canonicalJson(body)));
  return base64Url(new Uint8Array(signature));
}

function validIdentity(value: string): boolean {
  return /^[\x21-\x7e]{1,256}$/.test(value);
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

export async function createOperatorProbeRequest(input: {
  readonly challenge: Uint8Array;
  readonly declaredOperatorId: string;
  readonly documentType: string;
  readonly configEtag: string | null;
  readonly issuedAt: Date;
  readonly ttlSeconds: number;
  readonly keyBytes: Uint8Array;
}): Promise<{ readonly body: OperatorProbeRequestBody; readonly signature: string }> {
  try {
    if (input.challenge.byteLength !== 32 || !validIdentity(input.declaredOperatorId) || !DocumentTypeSchema.safeParse(input.documentType).success
      || input.configEtag !== null && !ExternalEtagSchema.safeParse(input.configEtag).success || !validDate(input.issuedAt)
      || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 300) throw new OperatorProbeError();
    const issuedAt = new Date(Math.floor(input.issuedAt.getTime() / 1000) * 1000);
    const body: OperatorProbeRequestBody = {
      protocol: "unidocs-operator-probe-request/v1",
      challenge: base64Url(input.challenge),
      declaredOperatorId: input.declaredOperatorId,
      documentType: input.documentType,
      configEtag: input.configEtag,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlSeconds * 1000).toISOString(),
    };
    return { body, signature: await sign(REQUEST_DOMAIN, body, input.keyBytes) };
  } catch {
    throw new OperatorProbeError();
  }
}

export function signOperatorProbeReceipt(receipt: OperatorProbeReceipt, keyBytes: Uint8Array): Promise<string> {
  return sign(RECEIPT_DOMAIN, receipt, keyBytes).catch(() => { throw new OperatorProbeError(); });
}

export async function verifyOperatorProbeReceipt(
  value: unknown,
  signature: string,
  request: OperatorProbeRequestBody,
  keyBytes: Uint8Array,
  now: Date,
): Promise<OperatorProbeReceipt> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).sort().join(",") !== "challenge,configEtag,declaredOperatorId,documentType,expiresAt,issuedAt,protocol") throw new OperatorProbeError();
    const receipt = value as OperatorProbeReceipt;
    if (receipt.protocol !== "unidocs-operator-probe-receipt/v1" || receipt.challenge !== request.challenge
      || receipt.declaredOperatorId !== request.declaredOperatorId || receipt.documentType !== request.documentType
      || receipt.configEtag !== request.configEtag || receipt.issuedAt !== request.issuedAt || receipt.expiresAt !== request.expiresAt
      || !validDate(now)) throw new OperatorProbeError();
    const issuedAt = Date.parse(receipt.issuedAt);
    const expiresAt = Date.parse(receipt.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || now.getTime() < issuedAt || now.getTime() > expiresAt || expiresAt - issuedAt > 300_000) throw new OperatorProbeError();
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(keyBytes, "verify"), arrayBuffer(signatureBytes(signature)), encoder.encode(RECEIPT_DOMAIN + canonicalJson(receipt)));
    if (!valid) throw new OperatorProbeError();
    return receipt;
  } catch {
    throw new OperatorProbeError();
  }
}