export {
  DeltaRejectedError,
  DocExistsError,
  DocNotFoundError,
  RootRefsError,
  StorageCorruptError,
  VersionConflictError,
} from "./errors.js";

export { SValueContentType } from "./http.js";
export type {
  ApplyResult,
  CreateResult,
  DocApplyRequest,
  DocApplyResponse,
  DocCreateRequest,
  DocCreateResponse,
  DocEndpointContracts,
  DocErrorResponse,
  DocExportRequest,
  DocExportResponse,
  DocHistoryRequest,
  DocHistoryResponse,
  DocInitFromHashRequest,
  DocInitFromHashResponse,
  DocIrRequest,
  DocIrResponse,
  DocNegotiatedResponse,
  DocPrivateEndpointContracts,
  DocQueryRequest,
  DocQueryResponse,
  DocReadBlobRequest,
  DocReadBlobResponse,
  DocResetOperatorRequest,
  DocResetOperatorResponse,
  DocResolveBlobRequest,
  DocResolveBlobResponse,
  DocRollbackRequest,
  DocRollbackResponse,
  DocRunOperatorRequest,
  DocRunOperatorResponse,
  DocSessionPath,
  DocSnapshotRequest,
  DocSnapshotResponse,
  DocStatusRequest,
  DocStatusResponse,
  DocStructuredRequestBody,
  HistoryEntry,
  RollbackResult,
  SnapshotRef,
} from "./http.js";

export {
  docInternalRoutes,
  docRoutes,
  matchDocInternalRoute,
  matchDocRoute,
} from "./routes.js";
export type {
  DocInternalOperation,
  DocInternalRoute,
  DocOperation,
  DocRoute,
} from "./routes.js";
export {
  consoleObserver,
  httpCallEvent,
  httpCallFailure,
  noopObserver,
  ObservedBodyCap,
  ObservedStackCap,
  ObservedHeaderAllowlist,
  pickObservedHeaders,
  readObservedBody,
  truncateObservedBody,
} from "./observe.js";
export { observedFailure } from "./observe.js";
export type {
  AgentRunEvent, AgentStepEvent, HttpCallEvent, HttpCallInput, ObservedEvent, ObserveFn,
} from "./observe.js";
