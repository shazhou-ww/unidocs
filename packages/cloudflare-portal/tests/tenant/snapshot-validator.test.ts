import { describe, expect, it } from "vitest";
import type { SValueSchema } from "@unidocs/protocol";
import { createSBlob, encodeSValue } from "@unidocs/svalue-codec";
import { MAX_SNAPSHOT_BYTES, validateSnapshotBytes } from "../../src/tenant/snapshot-validator.js";

const DIALECT = "https://schemas.unidocs.dev/svalue/v1";

const markdownSnapshot = {
  $schema: DIALECT,
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: {
    content: { type: "string" },
  },
} as unknown as SValueSchema;

describe("validateSnapshotBytes", () => {
  it("accepts canonical SValue bytes matching the schema", () => {
    const bytes = encodeSValue({ content: "# a" });
    expect(validateSnapshotBytes(bytes, markdownSnapshot)).toEqual({ ok: true });
  });

  it("rejects a value whose field type does not match the schema", () => {
    const bytes = encodeSValue({ content: 1 });
    expect(validateSnapshotBytes(bytes, markdownSnapshot)).toEqual({ ok: false, code: "invalid_request" });
  });

  it("rejects a value with a property the schema does not allow", () => {
    const bytes = encodeSValue({ content: "a", extra: "b" });
    expect(validateSnapshotBytes(bytes, markdownSnapshot)).toEqual({ ok: false, code: "invalid_request" });
  });

  it("rejects bytes that are not valid CBOR", () => {
    const bytes = new Uint8Array([0xff, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    expect(validateSnapshotBytes(bytes, markdownSnapshot)).toEqual({ ok: false, code: "invalid_request" });
  });

  it("rejects garbage bytes over MAX_SNAPSHOT_BYTES", () => {
    const bytes = new Uint8Array(MAX_SNAPSHOT_BYTES + 1); // all zeros, not valid CBOR
    expect(validateSnapshotBytes(bytes, markdownSnapshot)).toEqual({ ok: false, code: "invalid_request" });
  });

  it("rejects real, decodable SValue bytes over MAX_SNAPSHOT_BYTES by size alone", () => {
    // The brief's suggested proof-that-size-runs-before-decode ("time an
    // all-zero MAX+1 buffer, expect it to be fast") turned out not to
    // distinguish the size check from decoding: cborg's strict mode rejects
    // trailing bytes after the first token cheaply, so a decode-first
    // implementation is *also* fast on all-zero input (verified directly:
    // removing the size check left every test in this file green). This
    // test instead builds real, canonical, decodable SValue bytes over the
    // limit against a schema permissive enough to accept whatever they
    // decode to. A decode-first (or no-size-check) implementation would
    // decode and validate this successfully (ok: true); only rejecting it
    // by byte length alone proves the size check runs, and runs first.
    const permissive = { $schema: DIALECT } as unknown as SValueSchema;
    const chunk = "x".repeat(5000);
    const count = Math.ceil((MAX_SNAPSHOT_BYTES + 1024) / chunk.length) + 5;
    const bytes = encodeSValue({ content: Array.from({ length: count }, () => chunk) });
    expect(bytes.byteLength).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
    expect(validateSnapshotBytes(bytes, permissive)).toEqual({ ok: false, code: "invalid_request" });
  });

  it("reports unavailable when the schema declares an SBlob anywhere", () => {
    const withBlob = {
      ...markdownSnapshot,
      properties: { content: { type: "string" }, blob: { "x-unidocs-sblob": true } },
    } as unknown as SValueSchema;
    const bytes = encodeSValue({ content: "# a" });
    expect(validateSnapshotBytes(bytes, withBlob)).toEqual({ ok: false, code: "unavailable" });
  });

  it("reports unavailable when the schema declares an SBlob nested inside an array construct (oneOf)", () => {
    const withArrayBlob = {
      ...markdownSnapshot,
      properties: {
        content: { oneOf: [{ type: "string" }, { "x-unidocs-sblob": true }] },
      },
    } as unknown as SValueSchema;
    const bytes = encodeSValue({ content: "# a" });
    expect(validateSnapshotBytes(bytes, withArrayBlob)).toEqual({ ok: false, code: "unavailable" });
  });

  it("rejects a schema that is not in the SValue dialect", () => {
    const foreign = { ...markdownSnapshot, $schema: "https://json-schema.org/draft/2020-12/schema" } as unknown as SValueSchema;
    const bytes = encodeSValue({ content: "# a" });
    expect(validateSnapshotBytes(bytes, foreign)).toEqual({ ok: false, code: "invalid_request" });
  });

  it("rejects an SValue containing an SBlob when the schema declares no SBlob field", () => {
    const bytes = encodeSValue({ content: createSBlob("a".repeat(64)) } as never);
    expect(validateSnapshotBytes(bytes, markdownSnapshot)).toEqual({ ok: false, code: "invalid_request" });
  });
});
