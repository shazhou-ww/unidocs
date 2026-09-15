/**
 * Validates an Agent-submitted snapshot's canonical SValue CBOR bytes against
 * a Document Contract revision's snapshot schema.
 *
 * The schema is an SValue schema - JSON Schema 2020-12 plus the
 * x-unidocs-sblob keyword (see location-validator.ts) - but unlike a location
 * schema, a snapshot schema is allowed to describe a whole document body, not
 * just a small envelope. v0 has no way to validate a snapshot that embeds an
 * SBlob (the JSON projection cannot represent one - see toJsonValue), so a
 * schema that declares x-unidocs-sblob anywhere is a server capability gap
 * (`unavailable`), not a caller mistake.
 *
 * The byte-length check runs before any decode: an oversized submission is
 * refused by size alone, without spending CPU tokenizing attacker-controlled
 * bytes (R3, global-constraints).
 *
 * Never throws: `decodeSValue` and `toJsonValue` both throw on malformed
 * input, and a schema the validator cannot compile is likewise a caller
 * mistake - all of it collapses to `invalid_request`, never an uncaught 500.
 */
import { Validator } from "@cfworker/json-schema";
import type { SValueSchema } from "@unidocs/protocol";
import { SValueSchemaDialect } from "@unidocs/protocol";
import { decodeSValue, toJsonValue } from "@unidocs/svalue-codec";
import { declaresSBlob } from "./svalue-schema.js";

export type SnapshotValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid_request" | "unavailable" };

export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const INVALID: SnapshotValidation = { ok: false, code: "invalid_request" };
const UNAVAILABLE: SnapshotValidation = { ok: false, code: "unavailable" };

export function validateSnapshotBytes(bytes: Uint8Array, schema: SValueSchema): SnapshotValidation {
  try {
    if (schema.$schema !== SValueSchemaDialect) return INVALID;
    if (declaresSBlob(schema)) return UNAVAILABLE;
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return INVALID;

    const projection = toJsonValue(decodeSValue(bytes));

    const { $schema: _dialect, ...standard } = schema;
    const result = new Validator(standard as never, "2020-12", false).validate(projection);
    return result.valid ? { ok: true } : INVALID;
  } catch {
    return INVALID;
  }
}
