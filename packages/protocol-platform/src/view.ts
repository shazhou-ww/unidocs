/**
 * Sandboxed View bundle RPC contracts in both directions: Host-to-View
 * rendering and focus commands, plus View-to-Host data and mutation requests.
 *
 * Host -> View methods: `view.initialize`, `view.loadSnapshot`,
 * `view.setViewport`, `view.setMarkers`, `view.focusLocation`, and
 * `view.dispose`.
 * View -> Host methods: `host.readBlob`, `host.listThreads`, `host.getThread`,
 * `host.createThread`, `host.appendComment`, and `host.storeBlob`.
 * Every message uses `HostRpcRequest` / `HostRpcResponse` over MessageChannel;
 * this file intentionally defines no HTTP routes.
 */
import type { JsonValue, SValue } from "@unidocs/protocol";
import type {
  CasBlobRef,
  Cursor,
  DocumentLocation,
  Page,
  CommentIdx,
  ThreadId,
  VersionIdx,
  ViewBundleId,
} from "./common.js";
import type { AppendCommentRequest, CreateThreadRequest } from "./messages.js";
import type {
  DocumentRecord,
  CommentRecord,
  ThreadDetail,
  ThreadRef,
  VersionRecord,
} from "./resources.js";

export type RpcId = string;

export type HostRpcRequest<TMethod extends string, TParams> = {
  readonly kind: "request";
  readonly id: RpcId;
  readonly method: TMethod;
  readonly contextId: string;
  readonly params: TParams;
};

export type HostRpcResponse<TResult> =
  | {
    readonly kind: "response";
    readonly id: RpcId;
    readonly result: TResult;
  }
  | {
    readonly kind: "response";
    readonly id: RpcId;
    readonly error: { readonly code: string; readonly message: string };
  };

export interface ViewContext {
  readonly contextId: string;
  readonly document: DocumentRecord;
  readonly viewVersion: VersionRecord | null;
  readonly viewBundleId: ViewBundleId;
  readonly readOnly: boolean;
}

export type ViewRenderMode =
  | {
    readonly kind: "interactive";
  }
  | {
    readonly kind: "thumbnail";
    readonly viewport: {
      readonly width: number;
      readonly height: number;
      readonly devicePixelRatio: number;
    };
    readonly background: "document" | "transparent";
  };

export interface ViewInitializeRequest {
  readonly protocol: "unidocs-view-host/v1";
  readonly context: ViewContext;
  readonly mode: ViewRenderMode;
}

export interface ViewInitializeResponse {
  readonly acceptedProtocol: "unidocs-view-host/v1";
}

export interface ViewLoadSnapshotRequest {
  readonly context: ViewContext;
  readonly snapshot: SValue | null;
}

export interface ViewLoadSnapshotResponse {
  readonly renderedVersionIdx: VersionIdx | null;
}

export interface ViewSetViewportRequest {
  readonly revision: number;
  readonly state: JsonValue;
}

export interface ViewSetViewportResponse {
  readonly appliedRevision: number;
}

export interface ViewSetMarkersRequest {
  readonly revision: number;
  readonly markers: readonly {
    readonly threadId: ThreadId;
    readonly commentIdx: CommentIdx;
    readonly open: boolean;
    readonly location: DocumentLocation;
  }[];
}

export interface ViewFocusLocationResponse {
  readonly located: boolean;
  readonly reason: "located" | "unsupported_type" | "unresolvable";
}

export interface HostReadBlobRequest {
  readonly blob: CasBlobRef;
  readonly range: { readonly offset: number; readonly length?: number } | null;
}

export interface HostReadBlobResponse {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly complete: boolean;
}

export interface HostListThreadsRequest {
  readonly open: boolean | null;
  readonly versionIdx: VersionIdx | null;
  readonly cursor: Cursor | null;
  readonly limit: number;
}

export interface HostAppendCommentRequest extends AppendCommentRequest {
  readonly threadId: ThreadId;
}

export interface HostStoreBlobRequest {
  readonly purpose: "comment_attachment" | "comment_rich_content" | "view_draft";
  readonly contentType: string;
  readonly bytes: ArrayBuffer;
}

export interface ViewRpcContracts {
  readonly "view.initialize": {
    readonly request: ViewInitializeRequest;
    readonly response: ViewInitializeResponse;
  };
  readonly "view.loadSnapshot": {
    readonly request: ViewLoadSnapshotRequest;
    readonly response: ViewLoadSnapshotResponse;
  };
  readonly "view.setViewport": {
    readonly request: ViewSetViewportRequest;
    readonly response: ViewSetViewportResponse;
  };
  readonly "view.setMarkers": {
    readonly request: ViewSetMarkersRequest;
    readonly response: void;
  };
  readonly "view.focusLocation": {
    readonly request: DocumentLocation;
    readonly response: ViewFocusLocationResponse;
  };
  readonly "view.dispose": {
    readonly request: Record<string, never>;
    readonly response: void;
  };
}

export interface HostRpcContracts {
  readonly "host.readBlob": {
    readonly request: HostReadBlobRequest;
    readonly response: HostReadBlobResponse;
  };
  readonly "host.listThreads": {
    readonly request: HostListThreadsRequest;
    readonly response: Page<ThreadRef>;
  };
  readonly "host.getThread": {
    readonly request: ThreadId;
    readonly response: ThreadDetail;
  };
  readonly "host.createThread": {
    readonly request: CreateThreadRequest;
    readonly response: ThreadDetail;
  };
  readonly "host.appendComment": {
    readonly request: HostAppendCommentRequest;
    readonly response: CommentRecord;
  };
  readonly "host.storeBlob": {
    readonly request: HostStoreBlobRequest;
    readonly response: CasBlobRef;
  };
}