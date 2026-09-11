/**
 * The two ping-creation bodies, shared by the tenant HTTP API and the View
 * Host RPC.
 *
 * Everything else that used to live here — the public type catalog, documents,
 * versions, threads, current pointers, and CAS capability grants — now belongs
 * to `@unidocs/protocol-tenant-portal`, where the same operations are defined
 * contract-first with runtime schemas and generated OpenAPI. These two survive
 * because `host.createThread` and `host.appendPing` carry the identical
 * payloads across MessageChannel, which that package's HTTP contract does not
 * describe.
 */
import type { DocumentLocation, MessageContent, VersionIdx } from "./common.js";

export interface CreateThreadRequest {
  readonly baseVersionIdx: VersionIdx;
  readonly content: MessageContent;
  readonly location: DocumentLocation | null;
}

export interface AppendPingRequest {
  readonly baseVersionIdx: VersionIdx;
  readonly content: MessageContent;
  readonly location: DocumentLocation | null;
}
