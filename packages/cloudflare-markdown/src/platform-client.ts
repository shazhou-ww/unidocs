/**
 * The markdown Operator's view of the Portal's Agent API: read a document, a
 * thread and a snapshot, and submit versions and replies.
 *
 * Every request goes through the `PLATFORM_SERVICE` service binding, but its
 * URL is built from `PLATFORM_ORIGIN`, because the Portal only accepts a bearer
 * request whose URL origin is its own (R9). A rejected submission is a 201 like
 * a committed one, so it comes back as a receipt, never as an error.
 */
import { decodeSValue, requireRecord, requireString } from "@unidocs/svalue-codec";
import { SubmissionReceiptSchema, type AgentSubmissionRequest, type SubmissionReceipt } from "@unidocs/protocol-platform";
import { DocumentRecordSchema, ThreadDetailSchema, type DocumentRecord, type ThreadDetail } from "@unidocs/protocol-tenant-portal";

export interface PlatformClient {
  getDocument(tenantId: string, documentId: string): Promise<DocumentRecord>;
  getThread(tenantId: string, documentId: string, threadId: string): Promise<ThreadDetail>;
  /** The decoded `content` of a version's `{ content }` snapshot. */
  getSnapshotContent(tenantId: string, documentId: string, versionIdx: number): Promise<string>;
  submit(tenantId: string, documentId: string, body: AgentSubmissionRequest): Promise<SubmissionReceipt>;
}

export interface PlatformClientEnv {
  readonly PLATFORM_SERVICE: Fetcher;
  readonly PLATFORM_ORIGIN: string;
  readonly PLATFORM_AGENT_TOKEN: string;
}

export class PlatformRequestError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Platform request to ${path} failed with HTTP ${status}`);
    this.name = "PlatformRequestError";
  }
}

const seg = encodeURIComponent;

/** Builds nothing that can throw: a missing binding surfaces on the first request, inside the caller's error handling. */
export function createPlatformClient(env: PlatformClientEnv): PlatformClient {
  async function send(path: string, accept: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
    if (!env.PLATFORM_SERVICE || !env.PLATFORM_ORIGIN || !env.PLATFORM_AGENT_TOKEN) throw new TypeError("Platform bindings are not configured");
    const headers: Record<string, string> = { authorization: `Bearer ${env.PLATFORM_AGENT_TOKEN}`, accept };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const response = await env.PLATFORM_SERVICE.fetch(new Request(`${env.PLATFORM_ORIGIN}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    }));
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new PlatformRequestError(response.status, path);
    }
    return response;
  }

  const documentPath = (tenantId: string, documentId: string) => `/api/v1/tenants/${seg(tenantId)}/documents/${seg(documentId)}`;

  return {
    async getDocument(tenantId, documentId) {
      return DocumentRecordSchema.parse(await (await send(documentPath(tenantId, documentId), "application/json")).json());
    },
    async getThread(tenantId, documentId, threadId) {
      const response = await send(`${documentPath(tenantId, documentId)}/threads/${seg(threadId)}`, "application/json");
      return ThreadDetailSchema.parse(await response.json());
    },
    async getSnapshotContent(tenantId, documentId, versionIdx) {
      const response = await send(`${documentPath(tenantId, documentId)}/versions/${seg(String(versionIdx))}/snapshot`, "application/cbor");
      const snapshot = requireRecord(decodeSValue(new Uint8Array(await response.arrayBuffer())), "Markdown snapshot");
      return requireString(snapshot.content, "Markdown snapshot content");
    },
    async submit(tenantId, documentId, body) {
      const response = await send(`${documentPath(tenantId, documentId)}/submissions`, "application/json", { method: "POST", json: body });
      return SubmissionReceiptSchema.parse(await response.json());
    },
  };
}
