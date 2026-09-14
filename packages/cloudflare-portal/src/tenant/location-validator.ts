/**
 * Validates a comment location against its Document Contract revision's
 * location schema.
 *
 * createTenantThreadService takes this with no default on purpose, so it
 * cannot be skipped silently. The schema is an SValue schema - JSON Schema
 * 2020-12 plus the x-unidocs-sblob keyword - and it validates the
 * { locationType, payload } projection, not the whole envelope.
 *
 * A location is pure JSON (its payload is a JsonValue), so a location schema
 * that declares an SBlob anywhere is itself malformed and is refused.
 *
 * Never throws: a schema the validator cannot compile is a contract defect the
 * caller reports as location_contract_violation, not an uncoded 500.
 */
import { Validator } from "@cfworker/json-schema";
import type { DocumentLocationValidator } from "@unidocs/portal-service";
import { SValueSchemaDialect } from "@unidocs/protocol";
import { declaresSBlob } from "./svalue-schema.js";

export function createLocationValidator(): DocumentLocationValidator {
  return (location, schema) => {
    try {
      if (schema.$schema !== SValueSchemaDialect || declaresSBlob(schema)) return false;
      const { $schema: _dialect, ...standard } = schema;
      const projection = { locationType: location.locationType, payload: location.payload };
      return new Validator(standard as never, "2020-12", false).validate(projection).valid;
    } catch {
      return false;
    }
  };
}
