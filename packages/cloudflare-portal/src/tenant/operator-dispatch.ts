import { OperatorWebhookRequestSchema, OperatorWebhookResponseSchema } from "@unidocs/protocol-platform";
import { OperatorWebhookSignatureHeader, OperatorWebhookTimestampHeader, signOperatorWebhook } from "@unidocs/service-auth";
import type { createBoundOperatorTransport } from "../operator-transport.js";

/** A tenant write that has committed, and so may interest the document type's Operator. */
export type CommittedTenantWrite =
  | { readonly kind: "document.created"; readonly tenantId: string; readonly documentId: string }
  | { readonly kind: "comment.appended"; readonly tenantId: string; readonly documentId: string; readonly threadId: string; readonly commentIdx: number }
  | { readonly kind: "current_version.moved"; readonly tenantId: string; readonly documentId: string };

/** What the dispatcher needs from an Operator target: the bound transport's webhook and the per-baseUrl HMAC key. */
export interface OperatorWebhookTarget {
  readonly transport: Pick<ReturnType<typeof createBoundOperatorTransport>, "webhook">;
  readonly keys: { resolve(baseUrl: string): Promise<Uint8Array | null> };
}

export interface OperatorDispatcherOptions {
  readonly database: D1Database;
  /**
   * Builds the target on first use, at most once. It may throw (a missing
   * service binding, a malformed key): that is logged as a failed dispatch,
   * never raised, and a type with no builtin Operator never calls it.
   */
  readonly target: () => OperatorWebhookTarget;
  readonly now?: () => Date;
  readonly id?: () => string;
}

interface DocumentRow {
  readonly document_type: string;
  readonly current_version_idx: number | null;
  readonly base_url: unknown;
}

class OperatorWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorWebhookError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Sends the signed `unidocs-operator-webhook/v1` event for a committed write to
 * the document type's builtin Operator. R13: delivery is best effort - any
 * failure is logged as `portal_operator_webhook_failed` (name and message only)
 * and swallowed, with no retry and no rollback; later events and the Operator's
 * own idempotency absorb a lost one.
 */
export function createOperatorDispatcher(options: OperatorDispatcherOptions): (write: CommittedTenantWrite) => Promise<void> {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());
  let target: { readonly value: OperatorWebhookTarget } | undefined;
  const resolveTarget = () => (target ??= { value: options.target() }).value;

  return async write => {
    let eventId: string | null = null;
    try {
      eventId = id();
      const document = await options.database.prepare(
        `SELECT d.document_type, d.current_version_idx,
                json_extract(t.registration_json, '$.builtinOperator.baseUrl') AS base_url
         FROM portal_documents d
         LEFT JOIN portal_document_types t ON t.document_type = d.document_type
         WHERE d.tenant_id = ?1 AND d.document_id = ?2`,
      ).bind(write.tenantId, write.documentId).first<DocumentRow>();
      if (!document) throw new OperatorWebhookError("Document not found for Operator webhook");
      if (document.base_url === null) {
        console.log(JSON.stringify({ event: "portal_operator_webhook_skipped", eventId, documentId: write.documentId }));
        return;
      }
      if (typeof document.base_url !== "string") throw new OperatorWebhookError("Operator baseUrl is not a string");
      const baseUrl = document.base_url;

      let newComments: { threadId: string; commentIdx: number; acknowledgedCommentIdx: number | null }[] = [];
      if (write.kind === "comment.appended") {
        // The thread's derived acknowledged watermark (see thread-repository.ts),
        // left null rather than -1 when nothing has been replied to yet.
        const watermark = await options.database.prepare(
          `SELECT MAX(respond_through_comment_idx) AS acknowledged FROM portal_replies
           WHERE tenant_id = ?1 AND document_id = ?2 AND thread_id = ?3`,
        ).bind(write.tenantId, write.documentId, write.threadId).first<{ acknowledged: number | null }>();
        newComments = [{ threadId: write.threadId, commentIdx: write.commentIdx, acknowledgedCommentIdx: watermark?.acknowledged ?? null }];
      }

      const occurredAt = now();
      const event = OperatorWebhookRequestSchema.parse({
        protocol: "unidocs-operator-webhook/v1",
        eventId,
        reason: write.kind,
        tenantId: write.tenantId,
        documentId: write.documentId,
        documentType: document.document_type,
        currentVersionIdx: document.current_version_idx,
        newComments,
        occurredAt: occurredAt.toISOString(),
      });
      const body = encoder.encode(JSON.stringify(event));

      const { transport, keys } = resolveTarget();
      const key = await keys.resolve(baseUrl);
      if (!key) throw new OperatorWebhookError("No webhook key for the Operator");
      const { timestamp, signature } = await signOperatorWebhook(body, key, occurredAt);
      const path = `/tenants/${encodeURIComponent(write.tenantId)}/documents/${encodeURIComponent(write.documentId)}`;
      const response = await transport.webhook(baseUrl, path, body, {
        [OperatorWebhookTimestampHeader]: timestamp,
        [OperatorWebhookSignatureHeader]: signature,
      });
      const accepted = OperatorWebhookResponseSchema.safeParse(JSON.parse(decoder.decode(response.body)));
      if (!accepted.success || accepted.data.eventId !== eventId) throw new OperatorWebhookError("Operator did not accept the webhook event");
    } catch (error) {
      console.error(JSON.stringify({
        event: "portal_operator_webhook_failed", eventId, documentId: write.documentId,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };
}
