import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { D1PortalAuthRepository } from "../../../packages/cloudflare-portal/src/auth-repository.ts";
import { D1DocumentTypeRepository } from "../../../packages/cloudflare-portal/src/document-types-repository.ts";
import { D1OperatorValidationRepository } from "../../../packages/cloudflare-portal/src/operator-validations-repository.ts";
import { createOperatorValidationsHttp } from "../../../packages/cloudflare-portal/src/operator-validations-http.ts";
import { createDocumentTypeService, createOperatorValidationService, parseStrictJson, signOperatorProbeReceipt } from "../../../packages/portal-service/src/index.ts";

let miniflare;
let database;
const now = 1_800_000_000;
const identity = { issuer: "https://accounts.google.com", subject: "first", email: "first@example.com", authenticatedAt: now };
const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const descriptor = { protocol: "unidocs-operator/v1", declaredOperatorId: "markdown-primary", displayName: "Markdown Operator", supportedDocumentTypes: ["dt-markdown"], supportedDocumentContracts: { "dt-markdown": [0] } };

async function migrate(name) {
  const sql = await readFile(new URL(`../../../packages/cloudflare-portal/migrations/${name}`, import.meta.url), "utf8");
  await database.batch(sql.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => database.prepare(statement)));
}

beforeEach(async () => {
  miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "portal-operator-validations", modules: true, script: "export default { fetch() { return new Response('test'); } };",
    compatibilityDate: "2026-08-18", d1Databases: { DB: `portal-operator-validation-${crypto.randomUUID()}` },
  }] }));
  database = await miniflare.getD1Database("DB", "portal-operator-validations");
  for (const name of ["0001_admin_auth.sql", "0002_document_types.sql", "0003_document_contracts.sql", "0004_type_card_bundles.sql", "0005_view_bundles.sql", "0006_operator_validations.sql"]) await migrate(name);
});

afterEach(async () => { await miniflare?.dispose(); });

async function setup(invalidReceipt = false) {
  const auth = new D1PortalAuthRepository(database, () => now);
  const issued = await auth.completeLogin(identity, identity.email, "bootstrap");
  const context = { memberId: issued.memberId, identity, transport: "session", sessionHash: issued.session.sessionHash };
  const typeService = createDocumentTypeService(new D1DocumentTypeRepository(database, () => now), { now: () => new Date(now * 1000), id: () => "markdown" });
  await typeService.create(context, { internalName: "Markdown" }, "create-type", "create-type");
  await database.prepare(`INSERT INTO portal_document_contracts (document_type, document_contract_idx, contract_hash, record_json, created_at)
    VALUES ('dt-markdown', 0, 'sha256:contract', '{}', ?)`).bind(now).run();
  const transport = {
    discovery: vi.fn(async () => ({ body: new TextEncoder().encode(JSON.stringify(descriptor)), etag: '"operator-v1"', proofHeaders: {} })),
    probe: vi.fn(async (_baseUrl, body) => {
      const request = parseStrictJson(body);
      const receipt = { protocol: "unidocs-operator-probe-receipt/v1", challenge: invalidReceipt ? "wrong" : request.challenge, declaredOperatorId: request.declaredOperatorId, documentType: request.documentType, configEtag: request.configEtag, issuedAt: request.issuedAt, expiresAt: request.expiresAt };
      return { body: new TextEncoder().encode(JSON.stringify(receipt)), etag: null, proofHeaders: { "x-unidocs-probe-signature": await signOperatorProbeReceipt(receipt, keyBytes) } };
    }),
  };
  const repository = new D1OperatorValidationRepository(database, () => now);
  const service = createOperatorValidationService(repository, transport, { resolve: async () => keyBytes }, { now: () => new Date(now * 1000), id: (() => { let value = 0; return () => `operator-event-${++value}`; })(), challenge: () => new Uint8Array(32).fill(7) });
  return { context, repository, service, transport };
}

test("atomically publishes a validation, receipt, and success audit then replays before I/O", async () => {
  const { context, service, transport } = await setup();
  const request = { baseUrl: "https://operator.test", expectedDocumentType: "dt-markdown", expectedConfigEtag: null };
  const first = await service.validate(context, request, "validate-one", "request-one");
  const replay = await service.validate(context, request, "validate-one", "request-replay");
  expect(replay).toEqual(first);
  expect(transport.discovery).toHaveBeenCalledOnce();
  expect(transport.probe).toHaveBeenCalledOnce();
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_operator_validations").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_idempotency_receipts WHERE operation = 'createOperatorValidation'").first("count")).toBe(1);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_admin_audit WHERE action = 'operator.validation_passed'").first("count")).toBe(1);
});

test("hides expired validation records", async () => {
  const { context, repository, service } = await setup();
  const validation = await service.validate(context, { baseUrl: "https://operator.test", expectedDocumentType: "dt-markdown", expectedConfigEtag: null }, "validate-one", "request-one");
  expect(await repository.get(context, validation.validationId, new Date((now + 899) * 1000).toISOString())).not.toBeNull();
  expect(await repository.get(context, validation.validationId, new Date((now + 900) * 1000).toISOString())).toBeNull();
});

test("invalid proof creates only a bounded failure audit", async () => {
  const { context, service } = await setup(true);
  await expect(service.validate(context, { baseUrl: "https://operator.test", expectedDocumentType: "dt-markdown", expectedConfigEtag: null }, "validate-one", "request-one"))
    .rejects.toMatchObject({ code: "operator_validation_failed" });
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_operator_validations").first("count")).toBe(0);
  expect(await database.prepare("SELECT COUNT(*) AS count FROM portal_idempotency_receipts WHERE operation = 'createOperatorValidation'").first("count")).toBe(0);
  expect(await database.prepare("SELECT details_json FROM portal_admin_audit WHERE action = 'operator.validation_failed'").first("details_json")).toBe('{"phase":"probe"}');
});

test("HTTP creates and reads a current validation with stable errors", async () => {
  const { context, repository, transport } = await setup();
  let currentTime = now;
  const handle = createOperatorValidationsHttp(repository, transport, { resolve: async () => keyBytes }, { now: () => new Date(currentTime * 1000) });
  const base = "https://portal.test/admin/api/v1/operator-validations";
  const create = await handle(new Request(base, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-validation" },
    body: JSON.stringify({ baseUrl: "https://operator.test", expectedDocumentType: "dt-markdown", expectedConfigEtag: null }) }), context, "request-http");
  const createText = await create.text();
  expect(create.status, createText).toBe(200);
  const validation = JSON.parse(createText);
  const get = await handle(new Request(`${base}/${validation.validationId}`), context, "request-get");
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual(validation);
  currentTime += 901;
  const expired = await handle(new Request(`${base}/${validation.validationId}`), context, "request-expired");
  expect(expired.status).toBe(404);
});
