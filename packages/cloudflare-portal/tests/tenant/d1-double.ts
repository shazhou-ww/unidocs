import type { D1Database } from "@cloudflare/workers-types";

/**
 * Minimal D1Database test double shared by the tenant repository tests.
 *
 * `prepare` ignores both the SQL text and the bound parameters: every
 * statement returns the same canned `rows` from `all()`, and the first of
 * them from `first()`. That is enough for a repository that runs a single
 * unconditional read per call, which is all the catalog repository does.
 *
 * Task 4 extends this double with `batch()` support and statement recording
 * (it needs to assert what was written, not just canned what comes back);
 * keep additions here additive so tasks 5-8 can keep reusing the same double
 * instead of each forking their own.
 */
export function databaseDouble<Row extends Record<string, unknown>>(rows: readonly Row[]): D1Database {
  return {
    prepare(_sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          all: async () => ({ results: rows }),
          first: async () => rows[0] ?? null,
        }),
      };
    },
  } as unknown as D1Database;
}
