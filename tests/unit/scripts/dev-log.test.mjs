import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  devLogLine,
  devLogRecord,
  openDevLog,
} from "../../../stacks/unidocs-cloudflare/local/dev-log.mjs";

/** Fixed so the assertions can name the exact timestamp they expect. */
const T = 1_756_807_391_482;
const ISO = "2025-09-02T10:03:11.482Z";

/** One ESC byte, built rather than typed — a literal one in the source is
 *  invisible in a diff and easy to delete by accident. */
const ESC = String.fromCharCode(27);

test("a JSON line is flattened into the envelope, so `jq` can select on its own fields", () => {
  const record = devLogRecord({
    src: "worker",
    level: "log",
    timestamp: T,
    message: JSON.stringify({ event: "http_call", op: "lease", durationMs: 13004, ok: true }),
  });

  expect(record).toEqual({
    t: ISO,
    src: "worker",
    level: "log",
    event: "http_call",
    op: "lease",
    durationMs: 13004,
    ok: true,
  });
});

test("a non-JSON line keeps its text under `msg`", () => {
  expect(devLogRecord({ src: "miniflare", timestamp: T, message: "[mf:inf] Ready on http://x" }))
    .toEqual({ t: ISO, src: "miniflare", msg: "[mf:inf] Ready on http://x" });
});

test("`level` is omitted rather than written as undefined when the channel has none", () => {
  const record = devLogRecord({ src: "miniflare", timestamp: T, message: "hi" });
  expect("level" in record).toBe(false);
});

// The reason flattening is conditional at all. A payload carrying its own `t`
// would otherwise overwrite the envelope's timestamp — losing the one field
// that orders the file.
test("a payload that collides with an envelope key is nested, not flattened", () => {
  const record = devLogRecord({
    src: "worker",
    level: "log",
    timestamp: T,
    message: JSON.stringify({ t: "whenever", event: "http_call" }),
  });

  expect(record).toEqual({
    t: ISO,
    src: "worker",
    level: "log",
    json: { t: "whenever", event: "http_call" },
  });
});

test("ANSI colouring is stripped — an escape sequence inside a field breaks equality matching downstream", () => {
  const record = devLogRecord({
    src: "miniflare",
    timestamp: T,
    message: `${ESC}[31m[mf:err]${ESC}[39m boom`,
  });
  expect(record.msg).toBe("[mf:err] boom");
});

// Only `{...}` counts. A line that merely contains braces must not be parsed
// as a payload, and a JSON array is not an envelope we can flatten.
test.each([
  ["prose with a { brace", "prose with a { brace"],
  ["[1,2,3]", "[1,2,3]"],
  ["{not json}", "{not json}"],
  ["null", "null"],
])("%s is kept verbatim as msg", (message, expected) => {
  expect(devLogRecord({ src: "worker", timestamp: T, message }).msg).toBe(expected);
});

// The whole point of JSONL here: one record is always one line, so a stack
// trace cannot masquerade as dozens of unrelated log entries.
test("a multi-line message still produces exactly one line", () => {
  const line = devLogLine({
    src: "worker",
    level: "error",
    timestamp: T,
    message: "Error: boom\n    at a()\n    at b()",
  });

  expect(line.endsWith("\n")).toBe(true);
  expect(line.trimEnd().includes("\n")).toBe(false);
  expect(JSON.parse(line).msg).toBe("Error: boom\n    at a()\n    at b()");
});

test("openDevLog writes JSONL, truncates on open, and creates missing directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "unidocs-dev-log-"));
  const path = join(dir, "nested", "dev.log");
  try {
    const first = openDevLog(path);
    first.write({ src: "worker", level: "log", timestamp: T, message: '{"event":"a"}' });
    first.close();
    expect(readFileSync(path, "utf8")).toBe(`{"t":"${ISO}","src":"worker","level":"log","event":"a"}\n`);

    // A second run must not append to the previous run's file — otherwise
    // every read has to first work out which lines belong to this run.
    const second = openDevLog(path);
    second.write({ src: "worker", level: "log", timestamp: T, message: '{"event":"b"}' });
    second.close();
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Writes happen synchronously precisely so a second terminal (or an agent)
// can grep the file while the run is still going.
test("openDevLog's writes are visible before close", () => {
  const dir = mkdtempSync(join(tmpdir(), "unidocs-dev-log-"));
  const path = join(dir, "dev.log");
  try {
    const sink = openDevLog(path);
    sink.write({ src: "worker", level: "log", timestamp: T, message: '{"event":"live"}' });
    expect(JSON.parse(readFileSync(path, "utf8")).event).toBe("live");
    sink.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close is idempotent, and writing after close is a no-op rather than a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "unidocs-dev-log-"));
  const path = join(dir, "dev.log");
  try {
    const sink = openDevLog(path);
    sink.close();
    sink.close();
    // `dispose()` can run twice (Ctrl+C racing a failed startup); a throw here
    // would turn a clean shutdown into a stack trace.
    expect(() => sink.write({ src: "worker", timestamp: T, message: "late" })).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
