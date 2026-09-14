import { describe, expect, expectTypeOf, it } from "vitest";
import type { CasBlobRef, DocumentLocation, MessageContent } from "../src/index.js";
import {
  AgentSubmissionRequestSchema,
  CasBlobRefSchema,
  DocumentLocationSchema,
  MessageContentSchema,
  VersionIdxSchema,
} from "../src/schemas.js";

describe("shared primitives", () => {
  it("infers the same shape as the existing interfaces", () => {
    expectTypeOf<typeof CasBlobRefSchema._output>().toEqualTypeOf<CasBlobRef>();
    expectTypeOf<typeof DocumentLocationSchema._output>().toEqualTypeOf<DocumentLocation>();
    expectTypeOf<typeof MessageContentSchema._output>().toEqualTypeOf<MessageContent>();
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
