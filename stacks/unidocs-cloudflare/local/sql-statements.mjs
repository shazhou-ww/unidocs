/**
 * Split a `.sql` migration file into individual statements.
 *
 * Why this exists: D1's `db.exec()` splits its input on **newlines** and runs
 * each line as a complete statement. The gateway's migrations are written
 * one-statement-per-line, so `migrateSnapshotsDb` gets away with `exec`; the
 * portal's are authored for `wrangler d1 migrations apply` (a real splitter)
 * and are multi-line `CREATE TABLE (...)` blocks, which `exec` rejects with
 * `D1_EXEC_ERROR: ... incomplete input`. Rather than re-arm that trap for the
 * next service by reformatting its migrations, the runtime splits them here
 * and runs each statement through `prepare().run()`.
 *
 * Deliberately dependency-free (no imports at all), for the same reason
 * `doc-types.mjs` and `services.mjs` are: it is pure logic and must be
 * unit-testable without esbuild or Miniflare.
 *
 * What it understands, because a naive `sql.split(";")` is wrong for all of
 * these:
 *   - `'...'` string literals, including the `''` escape;
 *   - `"..."`, `` `...` `` and `[...]` quoted identifiers (and `""` escapes);
 *   - `-- line` and `/* block *\/` comments (stripped from the output);
 *   - `CREATE TRIGGER ... BEGIN stmt; stmt; END;` bodies, where the inner
 *     semicolons do not terminate the statement. Nesting is tracked by
 *     counting `BEGIN`/`CASE` against `END`, so a `CASE ... END` expression
 *     inside a trigger body does not close it early.
 *
 * Known limitation, stated rather than hidden: block nesting is keyword-based,
 * so a trigger body containing the bare words BEGIN/CASE/END as *identifiers*
 * (only possible if quoted, which this function already skips, or via a
 * SQLite-specific keyword-as-identifier quirk) could miscount. No migration in
 * this repository does that, and `wrangler`'s own splitter has the same shape.
 */

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/** Closing delimiter for each opening quote character. */
const QUOTE_CLOSERS = { "'": "'", '"': '"', "`": "`", "[": "]" };

export function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let blockDepth = 0;
  let inTrigger = false;
  let sawCreate = false;
  let index = 0;

  const flush = () => {
    if (current.trim().length > 0) statements.push(current.trim());
    current = "";
    blockDepth = 0;
    inTrigger = false;
    sawCreate = false;
  };

  while (index < sql.length) {
    const char = sql[index];
    const pair = sql.slice(index, index + 2);

    if (pair === "--") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
      current += " ";
      continue;
    }
    if (pair === "/*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      current += " ";
      continue;
    }
    const closer = QUOTE_CLOSERS[char];
    if (closer) {
      current += char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closer) {
          // Doubling the closer escapes it ('' inside '...', "" inside "...").
          if (sql[index + 1] === closer && closer !== "]") {
            current += closer + closer;
            index += 2;
            continue;
          }
          current += closer;
          index += 1;
          break;
        }
        current += sql[index];
        index += 1;
      }
      continue;
    }
    if (char === ";") {
      if (inTrigger && blockDepth > 0) {
        current += char;
        index += 1;
        continue;
      }
      index += 1;
      flush();
      continue;
    }
    if (IDENTIFIER_CHAR.test(char)) {
      let end = index;
      while (end < sql.length && IDENTIFIER_CHAR.test(sql[end])) end += 1;
      const word = sql.slice(index, end);
      current += word;
      index = end;
      const keyword = word.toUpperCase();
      if (keyword === "CREATE") sawCreate = true;
      else if (keyword === "TRIGGER" && sawCreate) inTrigger = true;
      if (inTrigger) {
        if (keyword === "BEGIN" || keyword === "CASE") blockDepth += 1;
        else if (keyword === "END" && blockDepth > 0) blockDepth -= 1;
      }
      continue;
    }
    current += char;
    index += 1;
  }
  flush();
  return statements;
}
