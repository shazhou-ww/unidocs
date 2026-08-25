/**
 * @unidocs/http-protocol — Cloud-neutral HTTP wire contracts for the
 * UniDocs microservices (gateway, cas, sdk). Type definitions plus the
 * few pure constructors/utilities needed to speak the wire format —
 * no I/O, no service logic.
 */

// Document API response shapes
export type {
  HistoryEntry,
  ApplyResult,
  RollbackResult,
  CreateResult,
} from "./history.js";

// Error classes with their HTTP status mapping
export {
  VersionConflictError,
  DeltaRejectedError,
  DocNotFoundError,
  DocExistsError,
  StorageCorruptError,
  RootRefsError,
} from "./errors.js";

// Query wire format
export type {
  BinaryQueryValue,
  EscapedQueryObject,
  WireQueryValue,
} from "./query-value.js";
export { encodeQueryValue } from "./query-value.js";

// CAS service wire contract
export type {
  CasHash,
  CasNode,
  CasNodeDescriptor,
  CasNodeMetadata,
  CasNodeState,
  CasLeaseResult,
  CasReferences,
  CasRefChanges,
  CasRootRefUpdate,
  CasRootAssignment,
  CasAssignRootsRequest,
  CasUsage,
  CasGcResult,
  TenantCasService,
} from "./cas.js";

// CAS public-route allowlist
export { isPublicCasRoute } from "./public-route.js";

// CAS client wire abstractions
export type { HttpFetcher, CasClientConfig } from "./cas-client.js";
export { CasClientError } from "./cas-client.js";
