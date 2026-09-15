/**
 * `POST /tenants/{tenantId}/documents/{documentId}`: the Portal's signed
 * Operator webhook (R11).
 *
 * The check order is fixed: not configured 503, unreadable body 400, bad
 * signature 401, then a body that is not this Operator's event for this path
 * 400. The signature is verified over the exact bytes received. An accepted
 * event is answered 200 at once and its work runs in `waitUntil`, because the
 * Portal's dispatch has a short deadline and acceptance never promised the work
 * was done.
 */
import { OperatorWebhookRequestSchema, type OperatorWebhookRequest } from "@unidocs/protocol-platform";
import { OperatorWebhookSignatureHeader, OperatorWebhookTimestampHeader, verifyOperatorWebhook } from "@unidocs/service-auth";
import { createSnapshotWriter, handleOperatorEvent, type OperatorCasEnv } from "./operator-agent.js";
import type { MarkdownOperatorBindings } from "./operator-endpoint.js";
import { operatorDocumentType, operatorHeaders, operatorKeyBytes, readBoundedJson } from "./operator-http.js";
import { createPlatformClient, type PlatformClientEnv } from "./platform-client.js";

const MAX_WEBHOOK_BYTES = 65_536;
const WEBHOOK_PATH = /^\/tenants\/([^/]+)\/documents\/([^/]+)$/;

/** Everything the webhook route reads. The Platform and CAS bindings are only touched by the scheduled work. */
export interface MarkdownOperatorWebhookBindings extends MarkdownOperatorBindings, Partial<PlatformClientEnv>, Partial<OperatorCasEnv> {}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function invalid(): Response {
  return Response.json({ error: "operator_webhook_invalid" }, { status: 400, headers: operatorHeaders() });
}

async function runEvent(event: OperatorWebhookRequest, env: MarkdownOperatorWebhookBindings): Promise<void> {
  // Both factories defer every binding check to their first call, which lands inside handleOperatorEvent's logging.
  await handleOperatorEvent(event, {
    platform: createPlatformClient(env as PlatformClientEnv),
    snapshots: createSnapshotWriter(env as OperatorCasEnv),
  });
}

export async function markdownOperatorWebhook(
  request: Request,
  env: MarkdownOperatorWebhookBindings,
  context: Pick<ExecutionContext, "waitUntil"> | undefined,
  now: () => Date = () => new Date(),
): Promise<Response | null> {
  const match = WEBHOOK_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const key = operatorKeyBytes(env.MARKDOWN_OPERATOR_HMAC_KEY);
  const documentType = operatorDocumentType(env.MARKDOWN_OPERATOR_DOCUMENT_TYPE);
  if (!key || !documentType) return Response.json({ error: "operator_not_configured" }, { status: 503, headers: operatorHeaders() });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: operatorHeaders({ Allow: "POST" }) });

  const body = await readBoundedJson(request, MAX_WEBHOOK_BYTES);
  if (!body) return invalid();
  const verified = await verifyOperatorWebhook(body.bytes, {
    timestamp: request.headers.get(OperatorWebhookTimestampHeader),
    signature: request.headers.get(OperatorWebhookSignatureHeader),
  }, key, now());
  if (!verified) return Response.json({ error: "operator_webhook_rejected" }, { status: 401, headers: operatorHeaders() });

  const parsed = OperatorWebhookRequestSchema.safeParse(body.value);
  if (!parsed.success) return invalid();
  const event = parsed.data;
  if (event.tenantId !== decodeSegment(match[1]) || event.documentId !== decodeSegment(match[2]) || event.documentType !== documentType) return invalid();

  const work = runEvent(event, env);
  if (context) context.waitUntil(work);
  else void work;
  return Response.json({ accepted: true, eventId: event.eventId }, { headers: operatorHeaders() });
}
