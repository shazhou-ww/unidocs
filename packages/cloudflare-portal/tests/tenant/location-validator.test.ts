import { describe, expect, it } from "vitest";
import type { SValueSchema } from "@unidocs/protocol";
import { createLocationValidator } from "../../src/tenant/location-validator.js";

const DIALECT = "https://schemas.unidocs.dev/svalue/v1";

const markdownRange = {
  $schema: DIALECT,
  type: "object",
  required: ["locationType", "payload"],
  additionalProperties: false,
  properties: {
    locationType: { const: "unidocs.markdown.text-range/v1" },
    payload: {
      type: "object",
      required: ["start", "end", "quote"],
      additionalProperties: false,
      properties: {
        start: { type: "integer", minimum: 0 },
        end: { type: "integer", minimum: 0 },
        quote: { type: "string" },
      },
    },
  },
} as unknown as SValueSchema;

const location = (payload: unknown, locationType = "unidocs.markdown.text-range/v1") => ({
  documentContractIdx: 0,
  locationType,
  payload: payload as never,
});

describe("createLocationValidator", () => {
  const validate = createLocationValidator();

  it("accepts a location matching the schema", () => {
    expect(validate(location({ start: 0, end: 5, quote: "hello" }), markdownRange)).toBe(true);
  });

  it("rejects a payload missing a required field", () => {
    expect(validate(location({ start: 0, end: 5 }), markdownRange)).toBe(false);
  });

  it("rejects a payload with an extra field", () => {
    expect(validate(location({ start: 0, end: 5, quote: "x", extra: 1 }), markdownRange)).toBe(false);
  });

  it("rejects a locationType the schema does not allow", () => {
    expect(validate(location({ start: 0, end: 5, quote: "x" }, "unidocs.psd.layer/v1"), markdownRange)).toBe(false);
  });

  it("validates the documentContractIdx-free projection, not the whole envelope", () => {
    // documentContractIdx is not part of the projection; additionalProperties:false
    // at the root would reject it if the validator passed the raw envelope.
    expect(validate(location({ start: 1, end: 2, quote: "a" }), markdownRange)).toBe(true);
  });

  it("refuses a schema that is not in the SValue dialect", () => {
    const foreign = { ...markdownRange, $schema: "https://json-schema.org/draft/2020-12/schema" } as unknown as SValueSchema;
    expect(validate(location({ start: 0, end: 5, quote: "x" }), foreign)).toBe(false);
  });

  it("refuses a location schema that declares an SBlob anywhere", () => {
    const withBlob = {
      ...markdownRange,
      properties: { ...(markdownRange as never as { properties: object }).properties, blob: { "x-unidocs-sblob": true } },
    } as unknown as SValueSchema;
    expect(validate(location({ start: 0, end: 5, quote: "x" }), withBlob)).toBe(false);
  });

  it("returns false rather than throwing on a malformed schema", () => {
    const broken = { $schema: DIALECT, type: 42 } as unknown as SValueSchema;
    expect(() => validate(location({}), broken)).not.toThrow();
    expect(validate(location({}), broken)).toBe(false);
  });
});
