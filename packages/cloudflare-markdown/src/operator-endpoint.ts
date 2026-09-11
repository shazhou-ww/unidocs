import { signOperatorProbeReceipt, verifyOperatorProbeRequest, type OperatorProbeReceipt } from "@unidocs/service-auth";
import { parseTree, type Node, type ParseError } from "jsonc-parser";

const MAX_PROBE_BYTES = 16_384;

export interface MarkdownOperatorBindings {
  readonly MARKDOWN_OPERATOR_HMAC_KEY?: string;
  readonly MARKDOWN_OPERATOR_DOCUMENT_TYPE?: string;
}

function headers(extra: Record<string, string> = {}) {
  return { "Cache-Control": "no-store", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...extra };
}

function keyBytes(value: string | undefined): Uint8Array | null {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
}

async function operatorConfig(documentType: string) {
  const descriptor = Object.freeze({
    protocol: "unidocs-operator/v1" as const,
    declaredOperatorId: "markdown-primary",
    displayName: "Markdown Operator",
    supportedDocumentTypes: [documentType],
    supportedDocumentContracts: { [documentType]: [0] },
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(descriptor))));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return { descriptor, etag: `"sha256-${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}"` };
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body || request.headers.has("content-encoding") || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new Error();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_PROBE_BYTES);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > bytes.byteLength) throw new Error();
      bytes.set(chunk.value, size - chunk.value.byteLength);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error();
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!root || errors.length) throw new Error();
  function inspect(node: Node, depth: number): void {
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
  }
  inspect(root, 0);
  return JSON.parse(text);
}

export async function markdownOperatorEndpoint(request: Request, env: MarkdownOperatorBindings, now: () => Date = () => new Date()): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/.well-known/unidocs-operator" && path !== "/operator/probe") return null;
  const key = keyBytes(env.MARKDOWN_OPERATOR_HMAC_KEY);
  const documentType = env.MARKDOWN_OPERATOR_DOCUMENT_TYPE;
  if (!key || !documentType || !/^[a-z][a-z0-9-]{0,63}$/.test(documentType)) return Response.json({ error: "operator_not_configured" }, { status: 503, headers: headers() });
  const config = await operatorConfig(documentType);
  if (path === "/.well-known/unidocs-operator") {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: headers({ Allow: "GET, HEAD" }) });
    return new Response(request.method === "HEAD" ? null : JSON.stringify(config.descriptor), { headers: headers({ ETag: config.etag }) });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: headers({ Allow: "POST" }) });
  try {
    const signature = request.headers.get("x-unidocs-probe-signature");
    if (!signature) throw new Error();
    const probe = await verifyOperatorProbeRequest(await boundedJson(request), signature, key, now());
    if (probe.declaredOperatorId !== config.descriptor.declaredOperatorId || probe.documentType !== documentType || probe.configEtag !== config.etag) throw new Error();
    const receipt: OperatorProbeReceipt = { protocol: "unidocs-operator-probe-receipt/v1", challenge: probe.challenge,
      declaredOperatorId: probe.declaredOperatorId, documentType: probe.documentType, configEtag: probe.configEtag,
      issuedAt: probe.issuedAt, expiresAt: probe.expiresAt };
    return Response.json(receipt, { headers: headers({ "X-UniDocs-Probe-Signature": await signOperatorProbeReceipt(receipt, key) }) });
  } catch {
    return Response.json({ error: "operator_probe_rejected" }, { status: 401, headers: headers() });
  }
}
