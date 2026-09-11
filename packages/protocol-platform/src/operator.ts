/**
 * Platform-to-Operator webhook contracts for document creation, new comments,
 * and current-version movement notifications.
 *
 * - `POST {operatorBaseUrl}/tenants/{tenantId}/documents/{documentId}`:
 *   deliver an at-least-once incremental work notification; acceptance does
 *   not imply that the corresponding Agent work has completed.
 */
import type {
  DocumentId,
  DocumentType,
  EndpointContract,
  IsoDateTime,
  CommentIdx,
  TenantId,
  ThreadId,
  VersionIdx,
} from "./common.js";

export type OperatorEventReason =
  | "document.created"
  | "comment.appended"
  | "current_version.moved";

export interface OperatorWebhookRequest {
  readonly protocol: "unidocs-operator-webhook/v1";
  readonly eventId: string;
  readonly reason: OperatorEventReason;
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
  readonly documentType: DocumentType;
  readonly currentVersionIdx: VersionIdx | null;
  readonly newComments: readonly {
    readonly threadId: ThreadId;
    readonly commentIdx: CommentIdx;
    readonly acknowledgedCommentIdx: CommentIdx | null;
  }[];
  readonly occurredAt: IsoDateTime;
}

export interface OperatorWebhookResponse {
  readonly accepted: true;
  readonly eventId: string;
}

export interface OperatorDocumentPath {
  readonly tenantId: TenantId;
  readonly documentId: DocumentId;
}

export interface OperatorEndpointContracts {
  readonly notifyDocument: EndpointContract<
    { readonly path: OperatorDocumentPath; readonly body: OperatorWebhookRequest },
    OperatorWebhookResponse
  >;
}