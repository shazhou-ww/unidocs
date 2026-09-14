/**
 * Shared between location-validator.ts and snapshot-validator.ts: true if an
 * SValue schema declares `x-unidocs-sblob` anywhere in its tree.
 *
 * Both validators refuse such schemas, for different reasons - a location is
 * pure JSON, so a location schema that declares an SBlob is itself malformed,
 * while the v0 snapshot validator simply has no SBlob support yet (a server
 * capability gap, not a caller error). The recursion itself does not know
 * which reason applies, so each validator maps a "declares SBlob" result to
 * its own outcome.
 *
 * No separate array branch: `Object.entries` on an array yields its
 * index/value pairs (not `length`, which is non-enumerable), so the object
 * branch below already recurses into array elements - including an
 * SBlob declared inside `oneOf`/`anyOf`/`items` tuples. A prior version had
 * an explicit `if (Array.isArray(node)) return node.some(declaresSBlob)`
 * branch; removing it changes nothing observable (verified directly, both
 * flat and array-nested), so it was dead code and is gone.
 */
export function declaresSBlob(node: unknown): boolean {
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-unidocs-sblob") return true;
      if (declaresSBlob(value)) return true;
    }
  }
  return false;
}
