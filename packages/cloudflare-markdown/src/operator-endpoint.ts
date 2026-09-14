import { signOperatorProbeReceipt, verifyOperatorProbeRequest, type OperatorProbeReceipt } from "@unidocs/service-auth";
import { operatorDocumentType, operatorHeaders as headers, operatorKeyBytes, readBoundedJson } from "./operator-http.js";

const MAX_PROBE_BYTES = 16_384;

export interface MarkdownOperatorBindings {
  readonly MARKDOWN_OPERATOR_HMAC_KEY?: string;
  readonly MARKDOWN_OPERATOR_DOCUMENT_TYPE?: string;
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

export async function markdownOperatorEndpoint(request: Request, env: MarkdownOperatorBindings, now: () => Date = () => new Date()): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/.well-known/unidocs-operator" && path !== "/operator/probe") return null;
  const key = operatorKeyBytes(env.MARKDOWN_OPERATOR_HMAC_KEY);
  const documentType = operatorDocumentType(env.MARKDOWN_OPERATOR_DOCUMENT_TYPE);
  if (!key || !documentType) return Response.json({ error: "operator_not_configured" }, { status: 503, headers: headers() });
  const config = await operatorConfig(documentType);
  if (path === "/.well-known/unidocs-operator") {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: headers({ Allow: "GET, HEAD" }) });
    return new Response(request.method === "HEAD" ? null : JSON.stringify(config.descriptor), { headers: headers({ ETag: config.etag }) });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: headers({ Allow: "POST" }) });
  try {
    const signature = request.headers.get("x-unidocs-probe-signature");
    if (!signature) throw new Error();
    const body = await readBoundedJson(request, MAX_PROBE_BYTES);
    if (!body) throw new Error();
    const probe = await verifyOperatorProbeRequest(body.value, signature, key, now());
    if (probe.declaredOperatorId !== config.descriptor.declaredOperatorId || probe.documentType !== documentType || probe.configEtag !== config.etag) throw new Error();
    const receipt: OperatorProbeReceipt = { protocol: "unidocs-operator-probe-receipt/v1", challenge: probe.challenge,
      declaredOperatorId: probe.declaredOperatorId, documentType: probe.documentType, configEtag: probe.configEtag,
      issuedAt: probe.issuedAt, expiresAt: probe.expiresAt };
    return Response.json(receipt, { headers: headers({ "X-UniDocs-Probe-Signature": await signOperatorProbeReceipt(receipt, key) }) });
  } catch {
    return Response.json({ error: "operator_probe_rejected" }, { status: 401, headers: headers() });
  }
}
