/**
 * host 与 view 之间的唯一接缝。
 *
 * 本轮 view 跑在同进程，但走 protocol-platform/src/view.ts 的消息契约。换成隔离
 * iframe 时新增 createPostMessageChannel，本文件以外不动。
 */
import type {
  CasBlobRef,
  CreateThreadRequest,
  DocumentLocation,
  HostAppendCommentRequest,
  HostListThreadsRequest,
  HostReadBlobRequest,
  HostReadBlobResponse,
  HostStoreBlobRequest,
  Page,
  CommentRecord,
  ThreadDetail,
  ThreadId,
  ThreadRef,
  ViewFocusLocationResponse,
  ViewInitializeRequest,
  ViewInitializeResponse,
  ViewLoadSnapshotRequest,
  ViewLoadSnapshotResponse,
  ViewRpcContracts,
  ViewSetMarkersRequest,
  ViewSetViewportRequest,
  ViewSetViewportResponse,
} from "@unidocs/protocol-platform";

/** view 侧可以回调 host 的能力。 */
export interface HostImplementation {
  readBlob(request: HostReadBlobRequest): Promise<HostReadBlobResponse>;
  listThreads(request: HostListThreadsRequest): Promise<Page<ThreadRef>>;
  getThread(threadId: ThreadId): Promise<ThreadDetail>;
  createThread(request: CreateThreadRequest): Promise<ThreadDetail>;
  appendComment(request: HostAppendCommentRequest): Promise<CommentRecord>;
  storeBlob(request: HostStoreBlobRequest): Promise<CasBlobRef>;
  /**
   * 选区「添加评论」：View 把选区编码成 DocumentLocation 交给 host，host 在讨论面板里
   * 打开和「回复」同一个输入框，发送时再由 host 走草稿与 createThread。
   * 协议里还没有这个方法（见 docs/design/platform-v0/tenant/TODO.md）；换成
   * postMessage 前必须先把它加进 protocol-platform 的 host 契约。
   */
  composeComment(request: ComposeCommentRequest): Promise<void>;
}

export interface ComposeCommentRequest {
  readonly baseVersionIdx: number;
  readonly location: DocumentLocation;
}

export interface ViewImplementation {
  initialize(request: ViewInitializeRequest, host: HostImplementation): Promise<ViewInitializeResponse>;
  loadSnapshot(request: ViewLoadSnapshotRequest, host: HostImplementation): Promise<ViewLoadSnapshotResponse>;
  setViewport(request: ViewSetViewportRequest, host: HostImplementation): Promise<ViewSetViewportResponse>;
  setMarkers(request: ViewSetMarkersRequest, host: HostImplementation): Promise<void>;
  focusLocation(request: DocumentLocation, host: HostImplementation): Promise<ViewFocusLocationResponse>;
  dispose(request: Record<string, never>, host: HostImplementation): Promise<void>;
}

export type ViewMethod = keyof ViewRpcContracts extends `view.${infer M}` ? M : never;

export interface ViewChannel {
  callView<M extends ViewMethod>(
    method: M,
    request: Parameters<ViewImplementation[M]>[0],
  ): Promise<Awaited<ReturnType<ViewImplementation[M]>>>;
  dispose(): void;
}

/** 模拟跨界传输：两侧不共享对象引用，换 postMessage 时行为不变。 */
function copy<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

export function createLocalChannel(options: {
  view: ViewImplementation;
  host: HostImplementation;
}): ViewChannel {
  const { view, host } = options;
  let disposed = false;

  return {
    async callView(method, request) {
      if (disposed) throw new Error(`view channel is disposed; ${method} rejected`);
      const handler = view[method] as (
        request: unknown,
        host: HostImplementation,
      ) => Promise<unknown>;
      const result = await handler.call(view, copy(request), host);
      return copy(result) as never;
    },
    dispose() {
      disposed = true;
    },
  };
}
