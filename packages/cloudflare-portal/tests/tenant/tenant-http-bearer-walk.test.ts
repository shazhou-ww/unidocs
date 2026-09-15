/**
 * R10 contract walk: an Agent bearer may not take any tenant API write.
 *
 * The walk reads every procedure out of `tenantApiContract` instead of listing
 * routes by hand, so a write procedure added to the contract later fails here
 * until it has a fixture below - and with a fixture it passes only if its
 * handler refuses a bearer with 403. Each fixture body is valid enough to reach
 * the handler: oRPC validates input before the handler runs, so an invalid body
 * would answer 400 and hide a missing gate. The second test proves that by
 * sending every fixture as a session caller and requiring it not to be refused
 * as malformed, unauthorized, forbidden or not found.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { tenantApiContract } from "@unidocs/protocol-tenant-portal";
import type { TenantContext } from "@unidocs/portal-service";
import { D1TenantCatalogRepository } from "../../src/tenant/catalog-repository.js";
import { D1TenantDocumentRepository } from "../../src/tenant/document-repository.js";
import { D1TenantVersionRepository } from "../../src/tenant/version-repository.js";
import { D1TenantThreadRepository } from "../../src/tenant/thread-repository.js";
import { createLocationValidator } from "../../src/tenant/location-validator.js";
import { createTenantHttp } from "../../src/tenant/tenant-http.js";
import type { SnapshotStore } from "../../src/snapshot-store.js";
import { startRealD1, type RealD1 } from "./real-d1.js";

const ORIGIN = "http://127.0.0.1:8795";
const session: TenantContext = { tenantId: "t-local", principalId: "user-local", transport: "session", sessionHash: "h" };
const agent: TenantContext = {
  tenantId: "t-local", principalId: "agent:markdown-primary", transport: "bearer",
  scopes: ["documents:read", "comments:read", "comments:reply", "versions:submit"],
};

interface Route { readonly method?: string; readonly path?: string }
interface Fixture { readonly body: unknown; readonly headers?: Record<string, string> }

const message = (text: string) => ({ text, richContent: null, attachments: [] });

/**
 * One valid request per write procedure, keyed by its dotted contract path. The
 * `idempotency-key` differs per caller in the tests so a session request is never
 * mistaken for a replay of the refused bearer one.
 */
const WRITE_FIXTURES: Record<string, Fixture> = {
  "documents.create": { body: { documentType: "markdown", name: "Walk" }, headers: { "idempotency-key": "walk-doc" } },
  "documents.moveCurrentVersion": { body: { observedCurrentVersionIdx: 0, targetVersionIdx: 0, reason: "walk" } },
  "threads.create": { body: { baseVersionIdx: 0, content: message("walk thread"), location: null }, headers: { "idempotency-key": "walk-thread" } },
  "threads.appendComment": { body: { baseVersionIdx: 0, content: message("walk comment"), location: null }, headers: { "idempotency-key": "walk-comment" } },
  "cas.issueCapability": { body: {} },
};

let real: RealD1;
let handle: ReturnType<typeof createTenantHttp>;
let params: Record<string, string>;

const snapshots: SnapshotStore = {
  read: async () => new ReadableStream({ start(controller) { controller.close(); } }),
  retain: async () => {},
  release: async () => {},
};

beforeEach(async () => {
  real = await startRealD1();
  handle = createTenantHttp({
    catalog: new D1TenantCatalogRepository(real.db),
    documents: new D1TenantDocumentRepository(real.db),
    versions: new D1TenantVersionRepository(real.db, snapshots),
    threads: new D1TenantThreadRepository(real.db),
    validateLocation: createLocationValidator(),
  });
  await seedDocumentWithVersion("doc-1");
  // appendComment needs a thread to exist; the session creates it before any count is taken.
  const thread = await send("POST", "/api/v1/tenants/t-local/documents/doc-1/threads",
    { body: { baseVersionIdx: 0, content: message("seed"), location: null }, headers: { "idempotency-key": "seed-thread" } }, session);
  expect(thread.status).toBe(201);
  params = {
    tenantId: "t-local", documentId: "doc-1", threadId: (await thread.json() as { threadId: string }).threadId,
    documentType: "markdown", documentContractIdx: "0", versionIdx: "0",
  };
});

afterEach(async () => {
  await real.dispose();
});

/** Every contract procedure with its dotted path, found by walking the router object. */
function procedures(node: unknown, prefix: string[] = []): { name: string; route: Route }[] {
  if (typeof node !== "object" || node === null) return [];
  const orpc = (node as { "~orpc"?: { route?: Route } })["~orpc"];
  if (orpc) return [{ name: prefix.join("."), route: orpc.route ?? {} }];
  return Object.entries(node).flatMap(([key, child]) => procedures(child, [...prefix, key]));
}

function writeProcedures() {
  return procedures(tenantApiContract).filter(({ route }) => (route.method ?? "POST").toUpperCase() !== "GET");
}

function pathFor(name: string, template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match, param: string) => {
    const value = params[param];
    if (value === undefined) throw new Error(`${name}: no walk value for path parameter {${param}}`);
    return encodeURIComponent(value);
  });
}

function send(method: string, path: string, fixture: Fixture, caller: TenantContext, keySuffix = ""): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [header, value] of Object.entries(fixture.headers ?? {})) headers[header] = header === "idempotency-key" ? `${value}${keySuffix}` : value;
  return handle(new Request(`${ORIGIN}${path}`, { method, headers, body: JSON.stringify(fixture.body) }), caller, "req-walk");
}

async function rowCounts(): Promise<Record<string, number>> {
  const { results } = await real.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of results) {
    counts[name] = (await real.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>())?.n ?? 0;
  }
  return counts;
}

async function seedDocumentWithVersion(documentId: string) {
  await real.db.prepare(
    "INSERT OR IGNORE INTO portal_document_types (document_type, internal_name, enabled, registration_json, created_at) VALUES ('markdown', 'markdown', 1, '{}', '2026-09-14T00:00:00.000Z')",
  ).run();
  await real.db.prepare(
    "INSERT OR IGNORE INTO portal_document_contracts (document_type, document_contract_idx, contract_hash, record_json, created_at) VALUES ('markdown', 0, 'sha256:contract', ?, 0)",
  ).bind(JSON.stringify({
    documentType: "markdown",
    documentContractIdx: 0,
    formatVersion: 1,
    snapshot: {
      contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1",
      schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" },
      schemaHash: "sha256:snapshot",
    },
    location: {
      contentType: "application/vnd.unidocs.markdown.location+json;version=1",
      schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      schemaHash: "sha256:location",
    },
    contractHash: "sha256:contract",
    createdAt: "2026-09-14T00:00:00.000Z",
  })).run();
  await real.db.prepare(
    "INSERT INTO portal_documents (tenant_id, document_id, name, document_type, current_version_idx, created_at) VALUES ('t-local', ?, 'Notes', 'markdown', 0, 1757808000)",
  ).bind(documentId).run();
  await real.db.prepare(
    `INSERT INTO portal_versions (tenant_id, document_id, version_idx, parent_version_idx, document_contract_idx, author_agent_id, submission_id, addressed_comments_json, snapshot_blob_hash, snapshot_size, snapshot_content_type, created_at)
     VALUES ('t-local', ?, 0, NULL, 0, 'agent:test', 'sub-0', '[]', 'hash', 4, 'application/vnd.unidocs.markdown.snapshot+cbor;version=1', 1757808000)`,
  ).bind(documentId).run();
}

it("refuses an Agent bearer with 403 on every non-GET procedure in tenantApiContract, writing nothing", async () => {
  const writes = writeProcedures();
  // A walker that found nothing would pass vacuously.
  expect(writes.length).toBeGreaterThan(0);
  // A new write procedure has no fixture yet and fails here; a removed one leaves a stale fixture.
  expect(writes.map(({ name }) => name).sort()).toEqual(Object.keys(WRITE_FIXTURES).sort());

  const before = await rowCounts();
  const outcomes: Record<string, number> = {};
  for (const { name, route } of writes) {
    const response = await send(route.method ?? "POST", pathFor(name, route.path ?? ""), WRITE_FIXTURES[name], agent);
    outcomes[name] = response.status;
    await response.body?.cancel();
  }
  expect(outcomes).toEqual(Object.fromEntries(writes.map(({ name }) => [name, 403])));
  expect(await rowCounts()).toEqual(before);
});

it("every walk fixture reaches its handler when a session sends it, so a 403 above is the gate and not validation", async () => {
  for (const { name, route } of writeProcedures()) {
    const response = await send(route.method ?? "POST", pathFor(name, route.path ?? ""), WRITE_FIXTURES[name], session, "-session");
    const text = await response.text();
    expect({ name, status: response.status, rejected: [400, 401, 403, 404].includes(response.status), text })
      .toEqual({ name, status: response.status, rejected: false, text });
  }
});
