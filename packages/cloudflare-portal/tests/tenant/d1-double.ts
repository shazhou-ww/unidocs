import type { D1Database } from "@cloudflare/workers-types";

/** One `prepare(sql).bind(...args)` call observed by a `databaseDouble`. */
export interface RecordedStatement {
  readonly sql: string;
  readonly args: readonly unknown[];
}

/**
 * A `D1Database` test double that also records every statement it prepared
 * and bound, so a test can assert on the SQL and bound parameters a
 * repository actually sent — not just on the canned data it got back.
 */
export interface D1DatabaseDouble extends D1Database {
  readonly statements: readonly RecordedStatement[];
}

/**
 * Minimal D1Database test double shared by the tenant repository tests.
 *
 * `prepare` ignores the SQL text and the bound parameters when deciding what
 * to return: every statement returns the same canned `rows` from `all()`,
 * and the first of them from `first()`. Paging logic (slicing to `limit`,
 * deciding `nextCursor`) lives in the repository, not in this double, so a
 * test exercises it by seeding more rows than the `limit` it queries with —
 * seeding alone is enough, no query-shaped filtering is needed here.
 *
 * Every bound statement is still recorded on `.statements`, so a test that
 * *does* care what SQL or bind arguments a repository sent (e.g. that a
 * decoded cursor was actually bound into the query) can inspect it.
 *
 * Task 4 extends this double with `batch()` support; keep additions here
 * additive so tasks 5-8 can keep reusing the same double instead of each
 * forking their own.
 */
export function databaseDouble<Row extends Record<string, unknown>>(rows: readonly Row[]): D1DatabaseDouble {
  const statements: RecordedStatement[] = [];
  const double = {
    statements,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          statements.push({ sql, args });
          return {
            all: async () => ({ results: rows }),
            first: async () => rows[0] ?? null,
          };
        },
      };
    },
  };
  return double as unknown as D1DatabaseDouble;
}
