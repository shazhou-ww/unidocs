/**
 * The portal's CAS runtime could not be built - in practice a missing CAS_*
 * binding, as on `pnpm dev portal`. The worker's lazy snapshot store throws it
 * from `read`/`retain`/`release` in place of the construction error, so a
 * caller can tell "CAS is not configured" from a CAS request that failed by
 * type rather than by matching an error message. The construction error is
 * kept as `cause` for the log line; it never reaches a response.
 */
export class CasUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The portal CAS runtime is not configured", { cause });
    this.name = "CasUnavailableError";
  }
}
