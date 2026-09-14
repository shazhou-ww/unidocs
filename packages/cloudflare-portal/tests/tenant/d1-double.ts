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
  /**
   * Every `batch()` call, as the array of prepared statements it was given.
   * Empty when the repository under test never calls `batch()`.
   */
  readonly batchCalls: readonly unknown[][];
}

/**
 * Options form of {@link databaseDouble}. `rows` keeps the original
 * behaviour: every `all()` call returns the same canned rows, and `first()`
 * falls back to `rows[0]` once `firsts` is exhausted (or was never given).
 *
 * `firsts` is a queue consumed one entry per `first()` call, in call order,
 * regardless of which statement issued it. That is what a replay-then-write
 * repository needs: the pre-write idempotency check and a post-failure
 * re-read are two separate `first()` calls that must see two different
 * receipt rows.
 *
 * `batchThrows`, when set, makes every `batch()` call throw that error
 * instead of succeeding — used to exercise the "re-read the receipt after a
 * failed batch" path.
 *
 * `batchResults` is a queue consumed one entry per `batch()` call, in call
 * order. Each entry is the `meta.changes` for every statement in that call,
 * positionally. This is what a lock-in-the-WHERE-clause repository needs to
 * test both outcomes of an UPDATE...WHERE guard: the double cannot evaluate
 * SQL, so the test tells it what a real engine would have matched. When the
 * queue is empty (or an entry omits a position), that statement defaults to
 * `changes: 1`, preserving prior behaviour for tests that don't care.
 */
export interface D1DatabaseDoubleOptions<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows?: readonly Row[];
  readonly firsts?: readonly (Record<string, unknown> | null)[];
  readonly batchThrows?: Error;
  readonly batchResults?: readonly (readonly number[])[];
}

/**
 * Minimal D1Database test double shared by the tenant repository tests.
 *
 * `prepare` ignores the SQL text and the bound parameters when deciding what
 * to return: every statement returns the same canned `rows` from `all()`,
 * and the first of them from `first()` (or the next entry off `firsts`, see
 * {@link D1DatabaseDoubleOptions}). Paging logic (slicing to `limit`,
 * deciding `nextCursor`) lives in the repository, not in this double, so a
 * test exercises it by seeding more rows than the `limit` it queries with —
 * seeding alone is enough, no query-shaped filtering is needed here.
 *
 * Every bound statement is still recorded on `.statements`, so a test that
 * *does* care what SQL or bind arguments a repository sent (e.g. that a
 * decoded cursor was actually bound into the query) can inspect it.
 *
 * Task 4 extended this double with `batch()` support and the `firsts` queue;
 * Task 5 added the `batchResults` queue. Keep further additions here
 * additive so tasks 6-8 can keep reusing the same double instead of each
 * forking their own.
 */
export function databaseDouble<Row extends Record<string, unknown>>(rows: readonly Row[]): D1DatabaseDouble;
export function databaseDouble<Row extends Record<string, unknown>>(options: D1DatabaseDoubleOptions<Row>): D1DatabaseDouble;
export function databaseDouble<Row extends Record<string, unknown>>(
  arg: readonly Row[] | D1DatabaseDoubleOptions<Row>,
): D1DatabaseDouble {
  const options: D1DatabaseDoubleOptions<Row> = Array.isArray(arg) ? { rows: arg as readonly Row[] } : (arg as D1DatabaseDoubleOptions<Row>);
  const rows = options.rows ?? [];
  const firsts = [...(options.firsts ?? [])];
  const batchResults = [...(options.batchResults ?? [])];
  const statements: RecordedStatement[] = [];
  const batchCalls: unknown[][] = [];
  const double = {
    statements,
    batchCalls,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          statements.push({ sql, args });
          return {
            all: async () => ({ results: rows }),
            first: async () => (firsts.length > 0 ? firsts.shift() ?? null : rows[0] ?? null),
          };
        },
      };
    },
    batch: async (prepared: unknown[]) => {
      batchCalls.push(prepared);
      if (options.batchThrows) throw options.batchThrows;
      const changes = batchResults.length > 0 ? batchResults.shift() : undefined;
      return prepared.map((_, index) => ({ meta: { changes: changes?.[index] ?? 1 } }));
    },
  };
  return double as unknown as D1DatabaseDouble;
}
