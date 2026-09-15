import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { seedPortalCatalog } from "../../../stacks/unidocs-cloudflare/local/portal-seed.mjs";
import { decodeSValue } from "../../../packages/svalue-codec/src/index.ts";

/**
 * The whole tenant data plane loop on a real stack: a real portal worker, the
 * real markdown Operator worker beside it, real embedded UniCAS and real D1,
 * with nothing mocked. A tenant writes; the portal signs a webhook to the
 * Operator in waitUntil; the Operator, in its own waitUntil, reads the portal
 * back as an Agent, writes a snapshot to CAS and submits a version and/or a
 * reply; the portal verifies, commits and retains. The unit and lower-level
 * integration tests prove each hop; only this proves the hops agree.
 *
 * The steps share one runtime and one database and run in order: each one
 * depends on the state the previous one left behind. Everything the Operator
 * does is asynchronous, so results are polled for with a bound.
 */

// Distinct from every other portal test block and from `pnpm dev portal`.
const PORTS = { gateway: 19687, markdown: 19688, admin: 19692, mockOidc: 19693, edge: 19694, portal: 19695, portalBundles: 19696 };
const ORIGIN = `http://127.0.0.1:${PORTS.portal}`;
const TENANT = "t-local";
const SESSION_COOKIE = "__Host-unidocs_tenant";
const CSRF_COOKIE = "__Host-unidocs_tenant_csrf";
const AGENT_ID = "agent:markdown-primary";
const TEXT_RANGE = "unidocs.markdown.text-range/v1";
const NAME = "Operator loop e2e";
const NEW_TITLE = "新标题";
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 20_000;
/** Structured log events that explain why an asynchronous step never arrived. */
const DIAGNOSTIC_EVENTS = /portal_operator_webhook_failed|portal_operator_webhook_skipped|markdown_operator_event_failed|markdown_operator_submission_abandoned|portal_operation_failed|portal_snapshot_retain_failed|portal_cas_unavailable/;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const API = `${ORIGIN}/api/v1/tenants/${TENANT}`;

function cookieValue(response, name) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const index = pair.indexOf("=");
    if (pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return null;
}

describe("the operator loop on a real stack", () => {
  let runtime;
  let persistPath;
  let logFile;
  let documentType;
  let token;
  let csrf;
  let documentId;
  let questionThreadId;
  let rewriteThreadId;

  const read = headers => ({ headers: { cookie: `${SESSION_COOKIE}=${token}`, ...headers } });
  const write = body => ({
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });

  async function getJson(path, step) {
    const response = await fetch(`${API}${path}`, read());
    const text = await response.text();
    expect(response.status, `${step}: GET ${path} -> ${text}`).toBe(200);
    return JSON.parse(text);
  }

  /** The Operator's failure lines from the runtime log, so a timeout says why as well as what. */
  async function diagnostics() {
    try {
      const lines = (await readFile(logFile, "utf8")).split("\n").filter(line => DIAGNOSTIC_EVENTS.test(line));
      return lines.length ? `\nruntime log:\n${lines.slice(-20).join("\n")}` : "\n(no operator failure events in the runtime log)";
    } catch (error) {
      return `\n(runtime log unreadable: ${error.message})`;
    }
  }

  /** Polls every 250ms for up to 20s until `probe` reports `done`, then returns its `value`. */
  async function waitFor(what, probe) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let last;
    for (;;) {
      last = await probe();
      if (last.done) return last.value;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`timed out after ${POLL_TIMEOUT_MS}ms waiting for ${what}; last observed: ${JSON.stringify(last.observed)}${await diagnostics()}`);
  }

  async function snapshotContent(versionIdx, step) {
    const response = await fetch(`${API}/documents/${documentId}/versions/${versionIdx}/snapshot`, read());
    if (response.status !== 200) expect(response.status, `${step}: snapshot ${versionIdx} -> ${await response.text()}`).toBe(200);
    const contentType = response.headers.get("content-type");
    const value = decodeSValue(new Uint8Array(await response.arrayBuffer()));
    return { contentType, value };
  }

  /** Fresh on every call: the seed reconfigured Miniflare, which poisons earlier handles. */
  async function count(table) {
    const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ? AND document_id = ?`).bind(TENANT, documentId).first("count");
  }

  beforeAll(async () => {
    // runtime.mjs keys its bundle directory by the gateway port and never cleans it.
    await rm(join(ROOT, ".wrangler", "local-bundles", String(PORTS.gateway)), { recursive: true, force: true });
    persistPath = await mkdtemp(join(tmpdir(), "unidocs-portal-operator-loop-"));
    logFile = join(persistPath, "runtime.log");
    // docTypes: [] or every document type boots; the portal implies the markdown Operator worker.
    runtime = await startLocalRuntime({ docTypes: [], services: ["portal"], ports: PORTS, persistPath, logFile });
    ({ documentType } = await seedPortalCatalog(runtime));
  }, 240_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (persistPath) await rm(persistPath, { recursive: true, force: true });
  });

  test("1. a tenant creates a markdown document, which starts without a version", async () => {
    const session = await fetch(`${ORIGIN}/portal/auth/session`);
    expect(session.status, "step 1: tenant session").toBe(200);
    token = cookieValue(session, SESSION_COOKIE);
    csrf = cookieValue(session, CSRF_COOKIE);
    expect(token, "step 1: session cookie").toBeTruthy();
    expect(csrf, "step 1: csrf cookie").toBeTruthy();

    const response = await fetch(`${API}/documents`, write({ documentType, name: NAME }));
    const text = await response.text();
    expect(response.status, `step 1: POST documents -> ${text}`).toBe(201);
    const body = JSON.parse(text);
    expect(body.currentVersionIdx, "step 1: currentVersionIdx").toBeNull();
    expect(body.documentType, "step 1: documentType").toBe(documentType);
    documentId = body.documentId;
    expect(documentId, "step 1: documentId").toBeTruthy();
  });

  test("2. the Operator commits the first version", async () => {
    const document = await waitFor("the Operator to commit version 0 (document.currentVersionIdx === 0)", async () => {
      const observed = await getJson(`/documents/${documentId}`, "step 2");
      return { done: observed.currentVersionIdx === 0, value: observed, observed };
    });
    expect(document.currentVersionIdx, "step 2: currentVersionIdx").toBe(0);
  }, 30_000);

  test("3. version 0 is the document name as a heading, authored by the markdown Agent", async () => {
    const contract = await getJson(`/document-types/${documentType}/document-contracts/0`, "step 3");
    const { contentType, value } = await snapshotContent(0, "step 3");
    expect(contentType, "step 3: snapshot content type").toBe(contract.snapshot.contentType);
    expect(contentType, "step 3: snapshot content type is markdown's").toBe(`application/vnd.unidocs.${documentType}.snapshot+cbor;version=1`);
    expect(value, "step 3: decoded snapshot").toEqual({ content: `# ${NAME}\n\n` });

    const version = await getJson(`/documents/${documentId}/versions/0`, "step 3");
    expect(version.authorAgentId, "step 3: authorAgentId").toBe(AGENT_ID);
    expect(version.parentVersionIdx, "step 3: parentVersionIdx").toBeNull();
    expect(version.addressedComments, "step 3: addressedComments").toEqual([]);
  });

  test("4. the portal retained version 0's snapshot as a CAS business root", async () => {
    // The VersionRecord does not carry the blob reference, so read it from D1.
    const db = await runtime.mf.getD1Database("DB", "unidocs-portal");
    const row = await db.prepare(
      "SELECT snapshot_blob_hash FROM portal_versions WHERE tenant_id = ? AND document_id = ? AND version_idx = 0",
    ).bind(TENANT, documentId).first();
    expect(row?.snapshot_blob_hash, "step 4: version 0 blob hash").toBeTruthy();

    // Being readable is not enough: a node still under its upload lease is
    // readable too. Only a root reference proves the portal's retain landed,
    // and the Agent's own credential cannot create one (no refDomain).
    const roots = await runtime.storage.middlewareRetainedRoots(runtime.stackFixture.stackId, TENANT);
    const root = roots.find(entry => entry.hash === row.snapshot_blob_hash);
    expect(root, `step 4: ${row.snapshot_blob_hash} among retained roots ${JSON.stringify(roots)}`).toBeDefined();
    expect(root.count, "step 4: root reference count").toBeGreaterThanOrEqual(1);
  });

  test("5. a question on the heading opens a thread", async () => {
    const response = await fetch(`${API}/documents/${documentId}/threads`, write({
      baseVersionIdx: 0,
      content: { text: "这是什么？", richContent: null, attachments: [] },
      location: {
        documentContractIdx: 0,
        locationType: TEXT_RANGE,
        payload: { start: 0, end: `# ${NAME}`.length, quote: `# ${NAME}` },
      },
    }));
    const text = await response.text();
    expect(response.status, `step 5: POST threads -> ${text}`).toBe(201);
    const body = JSON.parse(text);
    questionThreadId = body.threadId;
    expect(questionThreadId, "step 5: threadId").toBeTruthy();
    expect(body.comments, "step 5: one comment").toHaveLength(1);
  });

  test("6. the Operator answers the question with a pure reply and no new version", async () => {
    const thread = await waitFor(`a reply on the question thread ${questionThreadId}`, async () => {
      const observed = await getJson(`/documents/${documentId}/threads/${questionThreadId}`, "step 6");
      return { done: observed.replies.length > 0, value: observed, observed };
    });
    expect(thread.replies, "step 6: exactly one reply").toHaveLength(1);
    const [reply] = thread.replies;
    expect(reply.respondThroughCommentIdx, "step 6: respondThroughCommentIdx").toBe(0);
    expect(reply.resultLocations, "step 6: resultLocations").toEqual([]);
    expect(reply.authorAgentId, "step 6: reply author").toBe(AGENT_ID);

    const document = await getJson(`/documents/${documentId}`, "step 6");
    expect(document.currentVersionIdx, "step 6: currentVersionIdx after a pure reply").toBe(0);
  }, 30_000);

  test("7. a rewrite request on the name opens another thread", async () => {
    const response = await fetch(`${API}/documents/${documentId}/threads`, write({
      baseVersionIdx: 0,
      content: { text: `改为：${NEW_TITLE}`, richContent: null, attachments: [] },
      location: {
        documentContractIdx: 0,
        locationType: TEXT_RANGE,
        payload: { start: 2, end: 2 + NAME.length, quote: NAME },
      },
    }));
    const text = await response.text();
    expect(response.status, `step 7: POST threads -> ${text}`).toBe(201);
    rewriteThreadId = JSON.parse(text).threadId;
    expect(rewriteThreadId, "step 7: threadId").toBeTruthy();
    expect(rewriteThreadId, "step 7: a different thread").not.toBe(questionThreadId);
  });

  test("8. the Operator rewrites the name in version 1 and replies with where it landed", async () => {
    const thread = await waitFor(`version 1 and a reply on the rewrite thread ${rewriteThreadId}`, async () => {
      const document = await getJson(`/documents/${documentId}`, "step 8");
      const observed = await getJson(`/documents/${documentId}/threads/${rewriteThreadId}`, "step 8");
      return {
        done: document.currentVersionIdx === 1 && observed.replies.length > 0,
        value: observed,
        observed: { currentVersionIdx: document.currentVersionIdx, replies: observed.replies.length },
      };
    });

    const version = await getJson(`/documents/${documentId}/versions/1`, "step 8");
    expect(version.parentVersionIdx, "step 8: parentVersionIdx").toBe(0);
    expect(version.authorAgentId, "step 8: version author").toBe(AGENT_ID);
    expect(version.addressedComments, "step 8: addressedComments").toEqual([
      { threadId: rewriteThreadId, commentIdx: 0, baseVersionIdx: 0 },
    ]);

    const { value } = await snapshotContent(1, "step 8");
    expect(value, "step 8: decoded snapshot").toEqual({ content: `# ${NEW_TITLE}\n\n` });

    expect(thread.replies, "step 8: exactly one reply").toHaveLength(1);
    const [reply] = thread.replies;
    expect(reply.respondThroughCommentIdx, "step 8: respondThroughCommentIdx").toBe(0);
    expect(reply.submissionId, "step 8: reply and version share a submission").toBe(version.submissionId);
    expect(reply.resultLocations, "step 8: one result location").toHaveLength(1);
    expect(reply.resultLocations[0].payload.quote, "step 8: result quote").toBe(NEW_TITLE);
  }, 30_000);

  test("9. neither thread is open any more", async () => {
    const page = await getJson(`/documents/${documentId}/threads?open=true`, "step 9");
    const open = page.items.map(item => item.threadId);
    expect(open, "step 9: open threads").not.toContain(questionThreadId);
    expect(open, "step 9: open threads").not.toContain(rewriteThreadId);

    // The filter must actually filter: both threads are still listed without it.
    const all = (await getJson(`/documents/${documentId}/threads`, "step 9")).items.map(item => item.threadId);
    expect(all, "step 9: all threads").toEqual(expect.arrayContaining([questionThreadId, rewriteThreadId]));
  });

  test("10. exactly three submissions and two versions: no version for a conversation, no duplicate", async () => {
    expect(await count("portal_submissions"), "step 10: portal_submissions (first version, pure reply, rewrite)").toBe(3);
    expect(await count("portal_versions"), "step 10: portal_versions").toBe(2);
  });
});
