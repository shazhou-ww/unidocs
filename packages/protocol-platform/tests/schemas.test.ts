import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CasBlobRef,
  DocumentLocation,
  MessageContent,
  OperatorWebhookRequest,
  ReplyRecord,
  SubmissionReceipt,
  VersionRecord,
} from "../src/index.js";
import {
  AgentSubmissionRequestSchema,
  CasBlobRefSchema,
  DocumentLocationSchema,
  MessageContentSchema,
  OperatorWebhookRequestSchema,
  ReplyRecordSchema,
  SubmissionReceiptSchema,
  VersionIdxSchema,
  VersionRecordSchema,
} from "../src/schemas.js";

describe("shared primitives", () => {
  it("infers the same shape as the existing interfaces", () => {
    expectTypeOf<typeof CasBlobRefSchema._output>().toEqualTypeOf<CasBlobRef>();
    expectTypeOf<typeof DocumentLocationSchema._output>().toEqualTypeOf<DocumentLocation>();
    expectTypeOf<typeof MessageContentSchema._output>().toEqualTypeOf<MessageContent>();
    expectTypeOf<typeof VersionRecordSchema._output>().toEqualTypeOf<VersionRecord>();
    expectTypeOf<typeof ReplyRecordSchema._output>().toEqualTypeOf<ReplyRecord>();
    expectTypeOf<typeof SubmissionReceiptSchema._output>().toEqualTypeOf<SubmissionReceipt>();
    expectTypeOf<typeof OperatorWebhookRequestSchema._output>().toEqualTypeOf<OperatorWebhookRequest>();
  });

  it("rejects a negative record index", () => {
    expect(VersionIdxSchema.safeParse(-1).success).toBe(false);
    expect(VersionIdxSchema.safeParse(0).success).toBe(true);
  });

  it("requires a blob hash, size and content type", () => {
    expect(CasBlobRefSchema.safeParse({ blobHash: "h", size: 0, contentType: "text/plain" }).success).toBe(true);
    expect(CasBlobRefSchema.safeParse({ blobHash: "", size: 0, contentType: "text/plain" }).success).toBe(false);
    expect(CasBlobRefSchema.safeParse({ blobHash: "h", size: -1, contentType: "text/plain" }).success).toBe(false);
  });

  it("requires message content to carry text or rich content", () => {
    expect(MessageContentSchema.safeParse({ text: "hi", richContent: null, attachments: [] }).success).toBe(true);
    expect(MessageContentSchema.safeParse({ text: null, richContent: null, attachments: [] }).success).toBe(false);
    expect(MessageContentSchema.safeParse({ text: "", richContent: null, attachments: [] }).success).toBe(false);
  });
});

const blob = { blobHash: "h", size: 12, contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1" };
const content = { text: "done", richContent: null, attachments: [] };
const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 0, end: 1, quote: "x" } };

const threadUpdate = (over = {}) => ({
  threadId: "th-1",
  observedAcknowledgedCommentIdx: null,
  respondThroughCommentIdx: 0,
  content,
  resultLocations: [],
  ...over,
});

describe("AgentSubmissionRequestSchema", () => {
  it("accepts a pure reply with no snapshot and no current-version lock", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      threadUpdates: [threadUpdate()],
    });
    expect(result.success).toBe(true);
  });

  it("rejects result locations without a new snapshot blob", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      threadUpdates: [threadUpdate({ resultLocations: [location] })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a new snapshot blob without an observed current version", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      newDocumentContractIdx: 0,
      newSnapshotBlob: blob,
      threadUpdates: [threadUpdate()],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a new snapshot blob without a paired document contract idx", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      observedCurrentVersionIdx: 3,
      newSnapshotBlob: blob,
      threadUpdates: [threadUpdate()],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a snapshot submission carrying both locks", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      observedCurrentVersionIdx: 3,
      newDocumentContractIdx: 0,
      newSnapshotBlob: blob,
      threadUpdates: [threadUpdate({ resultLocations: [location] })],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null observed current version on the first version", () => {
    const result = AgentSubmissionRequestSchema.safeParse({
      submissionId: "sub-1",
      observedCurrentVersionIdx: null,
      newDocumentContractIdx: 0,
      newSnapshotBlob: blob,
      threadUpdates: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("SubmissionReceiptSchema", () => {
  it("accepts a committed receipt with a version and replies", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "committed",
      version: {
        versionIdx: 1,
        parentVersionIdx: 0,
        documentContractIdx: 0,
        authorAgentId: "agent:operator-markdown",
        submissionId: "sub-1",
        addressedComments: [{ threadId: "th-1", commentIdx: 0, baseVersionIdx: 0 }],
        createdAt: "2026-09-12T00:00:00.000Z",
      },
      replies: [],
      committedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a committed pure reply whose version is null", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "committed",
      version: null,
      replies: [],
      committedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a rejected receipt carrying the conflict", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "rejected",
      reason: "version_conflict",
      conflict: {
        currentVersionIdx: 4,
        availableDocumentContractIdxs: [0],
        threads: [{ threadId: "th-1", acknowledgedCommentIdx: 1, latestCommentIdx: 2 }],
      },
      rejectedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown rejection reason", () => {
    const result = SubmissionReceiptSchema.safeParse({
      submissionId: "sub-1",
      state: "rejected",
      reason: "made_up",
      conflict: { currentVersionIdx: null, availableDocumentContractIdxs: [0], threads: [] },
      rejectedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

const webhook = (over = {}) => ({
  protocol: "unidocs-operator-webhook/v1",
  eventId: "evt-1",
  reason: "comment.appended",
  tenantId: "t-local",
  documentId: "doc-1",
  documentType: "markdown",
  currentVersionIdx: 0,
  newComments: [{ threadId: "th-1", commentIdx: 1, acknowledgedCommentIdx: 0 }],
  occurredAt: "2026-09-12T00:00:00.000Z",
  ...over,
});

describe("OperatorWebhookRequestSchema", () => {
  it("accepts an incremental comment notification", () => {
    expect(OperatorWebhookRequestSchema.safeParse(webhook()).success).toBe(true);
  });

  it("accepts a document.created notification with no current version", () => {
    const result = OperatorWebhookRequestSchema.safeParse(
      webhook({ reason: "document.created", currentVersionIdx: null, newComments: [] }),
    );
    expect(result.success).toBe(true);
  });

  it("refuses a wrong protocol literal", () => {
    expect(OperatorWebhookRequestSchema.safeParse(webhook({ protocol: "v2" })).success).toBe(false);
  });

  it("refuses an unknown reason", () => {
    expect(OperatorWebhookRequestSchema.safeParse(webhook({ reason: "document.deleted" })).success).toBe(false);
  });
});
