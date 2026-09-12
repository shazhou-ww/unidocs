import { describe, expect, expectTypeOf, it } from "vitest";
import type { CasBlobRef, DocumentLocation, MessageContent } from "../src/index.js";
import {
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
