/**
 * The markdown Operator's work for one webhook event (R16).
 *
 * - `document.created`: commit the first version, a heading with the document name.
 * - `comment.appended`: answer each thread's latest unacknowledged comment. A
 *   `改为：…` / `替换为：…` / `replace with: …` comment anchored on a text range
 *   rewrites that range in a new version and replies; anything else is a pure reply.
 * - `current_version.moved`: nothing.
 *
 * The Operator writes each snapshot to UniCAS itself, as an Agent: it may write
 * node content but carries no refDomain, so only the Portal's retain keeps it.
 * Every attempt re-reads Platform state, so a rejected receipt is recomputed
 * from what is there now; after three rejections the work is abandoned and
 * logged. Nothing here throws: webhook delivery is at-least-once and a later
 * event absorbs a lost one.
 */
import { createCasBlobClient } from "@unicas/tenant-blob-client";
import { createTenantCasClient } from "@unicas/tenant-client";
import { documentSnapshotContentType } from "@unidocs/protocol";
import type { AgentSubmissionRequest, CasBlobRef, OperatorWebhookRequest } from "@unidocs/protocol-platform";
import type { CommentRecord } from "@unidocs/protocol-tenant-portal";
import { casReadPermission, casWritePermission, createPkcs8CapabilityIssuer, type CapabilityIssuer } from "@unidocs/service-auth";
import { encodeSValue } from "@unidocs/svalue-codec";
import type { PlatformClient } from "./platform-client.js";

export interface SnapshotWriter {
  /** Stores `{ content }` as the document type's snapshot blob and returns its Platform reference. */
  write(tenantId: string, documentType: string, content: string): Promise<CasBlobRef>;
}

export interface OperatorCasEnv {
  readonly OPERATOR_CAS_ORIGIN: string;
  readonly OPERATOR_CAS_STACK_ID: string;
  readonly OPERATOR_CAS_ISSUER: string;
  readonly OPERATOR_CAS_AUDIENCE: string;
  readonly OPERATOR_CAS_SIGNING_KID: string;
  readonly OPERATOR_CAS_SIGNING_KEY: string;
}

export interface OperatorEventDependencies {
  readonly platform: PlatformClient;
  readonly snapshots: SnapshotWriter;
  readonly log?: (entry: object) => void;
}

/** R18: the Agent principal, namespaced apart from tenant users. */
const AGENT_SUBJECT = "agent:markdown-primary";
const TEXT_RANGE = "unidocs.markdown.text-range/v1";
const REPLACE_COMMENT = /^(?:改为|替换为|replace with)[:：]\s*([\s\S]+)$/i;
const MAX_ATTEMPTS = 3;
const CONTRACT_IDX = 0;

const CAS_BINDINGS = [
  "OPERATOR_CAS_ORIGIN", "OPERATOR_CAS_STACK_ID", "OPERATOR_CAS_ISSUER",
  "OPERATOR_CAS_AUDIENCE", "OPERATOR_CAS_SIGNING_KID", "OPERATOR_CAS_SIGNING_KEY",
] as const;

/** Imports the signing key on the first write, so a worker without CAS bindings still boots and answers webhooks. */
export function createSnapshotWriter(env: OperatorCasEnv): SnapshotWriter {
  let issuer: Promise<CapabilityIssuer> | undefined;
  return {
    async write(tenantId, documentType, content) {
      for (const name of CAS_BINDINGS) {
        if (!env[name]) throw new TypeError(`Operator CAS binding ${name} is missing`);
      }
      issuer ??= createPkcs8CapabilityIssuer({ issuer: env.OPERATOR_CAS_ISSUER, kid: env.OPERATOR_CAS_SIGNING_KID, privateKeyPkcs8: env.OPERATOR_CAS_SIGNING_KEY });
      const resolved = await issuer.catch(error => {
        issuer = undefined;
        throw error;
      });
      const cas = createTenantCasClient({
        baseUrl: env.OPERATOR_CAS_ORIGIN,
        stackId: env.OPERATOR_CAS_STACK_ID,
        tenantId,
        getToken: () => resolved.issue({
          subject: AGENT_SUBJECT,
          audience: env.OPERATOR_CAS_AUDIENCE,
          tenantId,
          permissions: [casReadPermission(tenantId), casWritePermission(tenantId)],
        }),
      });
      const bytes = encodeSValue({ content });
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      const ref = await createCasBlobClient(cas).storeBlob(body, { contentType: documentSnapshotContentType(documentType), size: bytes.byteLength });
      return { blobHash: ref.hash, size: ref.size, contentType: ref.contentType };
    },
  };
}

export async function handleOperatorEvent(event: OperatorWebhookRequest, deps: OperatorEventDependencies): Promise<void> {
  const log = deps.log ?? (entry => console.error(JSON.stringify(entry)));
  try {
    if (event.reason === "document.created") {
      await createFirstVersion(event, deps, log);
    } else if (event.reason === "comment.appended") {
      for (const threadId of new Set(event.newComments.map(comment => comment.threadId))) {
        await answerThread(event, threadId, deps, log);
      }
    }
  } catch (error) {
    log({
      event: "markdown_operator_event_failed",
      eventId: event.eventId,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createFirstVersion(event: OperatorWebhookRequest, { platform, snapshots }: OperatorEventDependencies, log: (entry: object) => void): Promise<void> {
  // A redelivered event for a document that already has a version.
  if (event.currentVersionIdx !== null) return;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const document = await platform.getDocument(event.tenantId, event.documentId);
    // Someone else initialized it, possibly while an earlier attempt was losing.
    if (document.currentVersionIdx !== null) return;
    const receipt = await platform.submit(event.tenantId, event.documentId, {
      submissionId: `evt-${event.eventId}-${attempt}`,
      observedCurrentVersionIdx: null,
      newDocumentContractIdx: CONTRACT_IDX,
      newSnapshotBlob: await snapshots.write(event.tenantId, event.documentType, `# ${document.name}\n\n`),
      threadUpdates: [],
    });
    if (receipt.state === "committed") return;
  }
  log({ event: "markdown_operator_submission_abandoned", eventId: event.eventId, documentId: event.documentId, attempts: MAX_ATTEMPTS });
}

async function answerThread(event: OperatorWebhookRequest, threadId: string, deps: OperatorEventDependencies, log: (entry: object) => void): Promise<void> {
  const { platform } = deps;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const thread = await platform.getThread(event.tenantId, event.documentId, threadId);
    const acknowledged = thread.replies.reduce<number | null>((max, reply) => max === null || reply.respondThroughCommentIdx > max ? reply.respondThroughCommentIdx : max, null);
    const latest = thread.comments.reduce<CommentRecord | null>((max, comment) => max === null || comment.commentIdx > max.commentIdx ? comment : max, null);
    // Already answered through the latest comment.
    if (latest === null || latest.commentIdx <= (acknowledged ?? -1)) return;
    const body = await submissionFor(event, `evt-${event.eventId}-${threadId}-${attempt}`, threadId, acknowledged, latest, deps);
    const receipt = await platform.submit(event.tenantId, event.documentId, body);
    if (receipt.state === "committed") return;
  }
  log({ event: "markdown_operator_submission_abandoned", eventId: event.eventId, documentId: event.documentId, threadId, attempts: MAX_ATTEMPTS });
}

async function submissionFor(
  event: OperatorWebhookRequest, submissionId: string, threadId: string, acknowledged: number | null, latest: CommentRecord,
  { platform, snapshots }: OperatorEventDependencies,
): Promise<AgentSubmissionRequest> {
  const watermark = { threadId, observedAcknowledgedCommentIdx: acknowledged, respondThroughCommentIdx: latest.commentIdx };
  const text = latest.content.text ?? "";
  const replyOnly = (replyText: string): AgentSubmissionRequest => ({
    submissionId,
    threadUpdates: [{ ...watermark, content: message(replyText), resultLocations: [] }],
  });
  const pureReply = (note = ""): AgentSubmissionRequest => replyOnly(`收到：${Array.from(text).slice(0, 80).join("")}${note}`);

  const replacement = REPLACE_COMMENT.exec(text)?.[1];
  const range = latest.location?.locationType === TEXT_RANGE ? textRange(latest.location.payload) : null;
  if (replacement === undefined || range === null) return pureReply();

  const document = await platform.getDocument(event.tenantId, event.documentId);
  const current = document.currentVersionIdx;
  if (current === null) return pureReply("（文档还没有版本，未修改）");
  const content = await platform.getSnapshotContent(event.tenantId, event.documentId, current);
  const start = content.slice(range.start, range.end) === range.quote ? range.start : content.indexOf(range.quote);
  if (start === -1) return pureReply(`（当前版本中找不到原文「${range.quote}」，未修改）`);

  const rewritten = content.slice(0, start) + replacement + content.slice(start + range.quote.length);
  // A version whose content equals the current one is forbidden (design §7.1, spec §8): answer without writing a snapshot.
  if (rewritten === content) return replyOnly(`内容已是「${replacement}」，未作修改`);
  return {
    submissionId,
    observedCurrentVersionIdx: current,
    newDocumentContractIdx: CONTRACT_IDX,
    newSnapshotBlob: await snapshots.write(event.tenantId, event.documentType, rewritten),
    threadUpdates: [{
      ...watermark,
      content: message(`已按评论修改：「${range.quote}」→「${replacement}」`),
      resultLocations: [{ documentContractIdx: CONTRACT_IDX, locationType: TEXT_RANGE, payload: { start, end: start + replacement.length, quote: replacement } }],
    }],
  };
}

function message(text: string) {
  return { text, richContent: null, attachments: [] };
}

/** A well-formed text-range payload with a non-empty quote; an empty quote would match anywhere. */
function textRange(payload: unknown): { start: number; end: number; quote: string } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { start, end, quote } = payload as Record<string, unknown>;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || typeof quote !== "string" || quote.length === 0) return null;
  return { start: start as number, end: end as number, quote };
}
