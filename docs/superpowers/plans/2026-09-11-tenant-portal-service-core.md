# Tenant Portal Service Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the cloud-neutral business core for all 15 Tenant v1 operations in `@unidocs/portal-service`, against repository interfaces, with unit tests.

**Architecture:** Mirror the administrator side exactly. `@unidocs/portal-service` owns validation, identity and timestamp generation, idempotency fingerprints, audit-event construction, and error mapping; it declares repository interfaces and never touches storage. Authorization is pushed into the repository, the way `D1DocumentTypeRepository.authorize()` already does, because the `DOCUMENT_GRANT` role vocabulary is still open in the ER model. D1 schemas, the oRPC handler wiring and tenant sessions are explicitly out of scope for this plan.

**Tech Stack:** TypeScript 5.9 (ESM, `composite` project references), Zod 4 schemas re-used from `@unidocs/protocol-tenant-portal`, Vitest 3, Web Crypto (`crypto.subtle`, `crypto.randomUUID`).

## Global Constraints

- Package: `packages/portal-service`. Business core only — no `@cloudflare/workers-types`, no D1, no `node:` imports in `src/`.
- Every DTO is parsed with the Zod schema exported by `@unidocs/protocol-tenant-portal`. Never hand-roll a shape that package already defines.
- Wire error codes come from `TenantApiErrorMap` in `packages/protocol-tenant-portal/src/contract.ts`: `invalid_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `limit_exceeded` 413, `location_contract_violation` 422, `document_type_disabled` 409, `version_conflict` 409, `idempotency_conflict` 409, `content_unavailable` 409, `unavailable` 503.
- `*Idx` fields are zero-based safe integers; `null`, never `0`, means "no record yet" (`docs/api-conventions.md`).
- Service methods take `(context, tenantId, …)`. The `tenantId` from the URL path and the one in the credential must be compared on every operation.
- Audit events are non-secret: never place an email, token, cookie, CSRF token or raw content into a `DocumentAuditEvent`.
- Idempotency keys are validated as `/^[\x21-\x7e]{1,128}$/`, matching `createDocumentType`.
- Code style follows `packages/portal-service/src/admin/document-types.ts`: dense, few comments, comments explain *why* rather than *what*.
- Commit messages are English, imperative, and explain the reasoning; do not push or open a PR as part of this plan.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/tenant/access.ts` | `TenantContext`, the two error classes, limits, and the guard functions every tenant service shares |
| `src/tenant/catalog.ts` | Enabled document type catalog and paired contract reads |
| `src/tenant/documents.ts` | Document creation, reads, the current-pointer move, and document audit |
| `src/tenant/versions.ts` | Version metadata reads and the snapshot byte stream |
| `src/tenant/threads.ts` | Thread and comment creation with anchor/location checking, plus thread reads |
| `src/tenant/cas.ts` | Short-lived UniCAS capability issuance through an issuer port |
| `src/index.ts` | Public entrypoint; extended once per task |
| `tests/tenant-*.test.ts` | One test file per service module, using `vi.fn()` repository fakes |

`src/tenant/` does not exist yet. An earlier untested draft of `access.ts` and `documents.ts` was deleted before this plan was written, so every file below is created test-first.

---

### Task 1: Package wiring and shared access primitives

**Files:**
- Modify: `packages/portal-service/package.json` (dependencies)
- Modify: `packages/portal-service/tsconfig.json` (references)
- Create: `packages/portal-service/src/tenant/access.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-access.test.ts`

**Interfaces:**
- Consumes: `PaginationQuerySchema` from `@unidocs/protocol-tenant-portal`.
- Produces: `TenantAccessError`, `TenantOperationError`, `TenantOperationCode`, `TenantContext`, `TENANT_LIMITS`, `requireTenantScope`, `requireIdempotencyKey`, `requireIdentifier`, `requireRecordIdx`, `requirePagination`, `requireExactFields`.

- [ ] **Step 1: Add the contract dependency and project reference**

In `packages/portal-service/package.json`, add to `dependencies` (keep keys sorted):

```json
    "@unidocs/protocol-tenant-portal": "workspace:*",
```

In `packages/portal-service/tsconfig.json`, extend `references`:

```json
  "references": [{ "path": "../protocol-admin-portal" }, { "path": "../protocol-tenant-portal" }]
```

Then run, from the repository root:

```bash
pnpm install --frozen-lockfile --offline --config.trust-lockfile=true --filter @unidocs/portal-service
```

If that reports the lockfile is out of date, add the importer entry by hand rather than letting pnpm rewrite resolutions: in `pnpm-lock.yaml`, inside `packages/portal-service:` → `dependencies:`, insert

```yaml
      '@unidocs/protocol-tenant-portal':
        specifier: workspace:*
        version: link:../protocol-tenant-portal
```

and re-run the install command.

- [ ] **Step 2: Write the failing test**

Create `packages/portal-service/tests/tenant-access.test.ts`:

```ts
import { expect, test } from "vitest";
import { requireExactFields, requireIdempotencyKey, requireIdentifier, requirePagination, requireRecordIdx, requireTenantScope, TENANT_LIMITS, TenantAccessError, TenantOperationError, type TenantContext } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };

test("a credential for one tenant cannot address another tenant", () => {
  expect(() => requireTenantScope(context, "tenant-a")).not.toThrow();
  expect(() => requireTenantScope(context, "tenant-b")).toThrow(expect.objectContaining({ code: "forbidden" }));
});

test.each(["", " ", "a".repeat(TENANT_LIMITS.identifier + 1)])("rejects an unusable tenant path segment %#", segment => {
  expect(() => requireTenantScope(context, segment)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test.each(["", "space key", "a".repeat(TENANT_LIMITS.idempotencyKey + 1), "non-ascii-é"])("rejects an unbounded or non-printable idempotency key %#", key => {
  expect(() => requireIdempotencyKey(key)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("accepts a printable bounded idempotency key", () => {
  expect(requireIdempotencyKey("retry-1")).toBe("retry-1");
});

test.each([undefined, 1, "", "with space", "a".repeat(TENANT_LIMITS.identifier + 1)])("rejects an invalid identifier %#", value => {
  expect(() => requireIdentifier(value)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test.each([-1, 1.5, Number.NaN, "0", null])("rejects a record index that is not zero-based %#", value => {
  expect(() => requireRecordIdx(value)).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("accepts zero as a record index, because null means absent", () => {
  expect(requireRecordIdx(0)).toBe(0);
});

test("bounds pagination and rejects an oversized cursor", () => {
  expect(requirePagination(undefined)).toEqual({});
  expect(requirePagination({ limit: 25 })).toEqual({ limit: 25 });
  expect(() => requirePagination({ limit: 0 })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requirePagination({ limit: 101 })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requirePagination({ cursor: "a".repeat(1025) })).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("rejects a body carrying a field the operation does not define", () => {
  expect(requireExactFields({ name: "Notes" }, ["name"])).toEqual({ name: "Notes" });
  expect(() => requireExactFields({ name: "Notes", owner: "someone" }, ["name"])).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requireExactFields([], ["name"])).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(() => requireExactFields(null, ["name"])).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("access failures are distinct from operation failures", () => {
  expect(new TenantAccessError("unauthorized")).toBeInstanceOf(Error);
  expect(new TenantOperationError("version_conflict").message).toBe("The observed current version does not match the current pointer");
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-access.test.ts
```

Expected: FAIL — `../src/index.js` exports none of these names.

- [ ] **Step 4: Write the implementation**

Create `packages/portal-service/src/tenant/access.ts`:

```ts
import { PaginationQuerySchema, type PaginationQuery } from "@unidocs/protocol-tenant-portal";

export class TenantAccessError extends Error {
  constructor(readonly code: "unauthorized" | "forbidden") {
    super(code === "unauthorized" ? "User authentication is required" : "The caller is not allowed to perform this operation");
    this.name = "TenantAccessError";
  }
}

export type TenantOperationCode = "invalid_request" | "forbidden" | "not_found" | "limit_exceeded"
  | "location_contract_violation" | "document_type_disabled" | "version_conflict" | "idempotency_conflict"
  | "content_unavailable" | "unavailable";

const MESSAGES: Readonly<Record<TenantOperationCode, string>> = {
  invalid_request: "The request is invalid",
  forbidden: "The caller is not allowed to perform this operation",
  not_found: "The requested resource was not found",
  limit_exceeded: "A size or quota limit was exceeded",
  location_contract_violation: "The location does not satisfy its Document Contract location schema",
  document_type_disabled: "The document type is not enabled for document creation",
  version_conflict: "The observed current version does not match the current pointer",
  idempotency_conflict: "The idempotency key was used with a different request",
  content_unavailable: "The referenced content is not available",
  unavailable: "The Platform is temporarily unavailable",
};

export class TenantOperationError extends Error {
  constructor(readonly code: TenantOperationCode) {
    super(MESSAGES[code]);
    this.name = "TenantOperationError";
  }
}

/**
 * Who is calling. Whether this principal may read or write a given document is
 * decided by the repository, the way administrator authority already is: the
 * document grant vocabulary is still open in the ER model, and the business
 * core must not freeze it by guessing.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly transport: "bearer" | "session";
  readonly sessionHash?: string;
  /** Present for Agent bearer tokens; a browser session carries none. */
  readonly scopes?: readonly string[];
}

export const TENANT_LIMITS = {
  documentName: 256,
  reason: 512,
  messageText: 16_384,
  attachments: 20,
  locationPayloadBytes: 8_192,
  idempotencyKey: 128,
  identifier: 128,
  cursor: 1_024,
} as const;

/**
 * The tenant appears in the path as well as in the credential. They must agree,
 * or one tenant's session addresses another tenant's documents.
 */
export function requireTenantScope(context: TenantContext, tenantId: unknown): void {
  if (typeof tenantId !== "string" || !tenantId.trim() || tenantId.length > TENANT_LIMITS.identifier) throw new TenantOperationError("invalid_request");
  if (tenantId !== context.tenantId) throw new TenantOperationError("forbidden");
}

export function requireIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !key || key.length > TENANT_LIMITS.idempotencyKey || /[^\x21-\x7e]/.test(key)) throw new TenantOperationError("invalid_request");
  return key;
}

export function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > TENANT_LIMITS.identifier || /[^\x21-\x7e]/.test(value)) throw new TenantOperationError("invalid_request");
  return value;
}

export function requireRecordIdx(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TenantOperationError("invalid_request");
  return value;
}

export function requirePagination(query: unknown): PaginationQuery {
  const parsed = PaginationQuerySchema.safeParse(query ?? {});
  if (!parsed.success || (parsed.data.cursor?.length ?? 0) > TENANT_LIMITS.cursor) throw new TenantOperationError("invalid_request");
  return parsed.data;
}

/** Reject bodies carrying fields the operation does not define, before they reach storage. */
export function requireExactFields(body: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TenantOperationError("invalid_request");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(field => !fields.includes(field))) throw new TenantOperationError("invalid_request");
  return record;
}
```

Append to `packages/portal-service/src/index.ts`:

```ts
export { requireExactFields, requireIdempotencyKey, requireIdentifier, requirePagination, requireRecordIdx, requireTenantScope, TENANT_LIMITS, TenantAccessError, TenantOperationError } from "./tenant/access.js";
export type { TenantContext, TenantOperationCode } from "./tenant/access.js";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-access.test.ts
pnpm --filter @unidocs/portal-service typecheck
```

Expected: PASS, and a clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/portal-service/package.json packages/portal-service/tsconfig.json packages/portal-service/src/tenant/access.ts packages/portal-service/src/index.ts packages/portal-service/tests/tenant-access.test.ts pnpm-lock.yaml
git commit -m "feat(tenant): add the tenant service access context and guards

TenantContext carries who is calling; whether that principal may read or
write a given document stays with the repository, because the document
grant vocabulary is still open in the ER model and the business core must
not freeze it by guessing. The tenant appears in both the path and the
credential, so every operation compares them."
```

---

### Task 2: Document type catalog

**Files:**
- Create: `packages/portal-service/src/tenant/catalog.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-catalog.test.ts`

**Interfaces:**
- Consumes: `TenantContext`, `TenantOperationError`, `requireTenantScope`, `requirePagination`, `requireRecordIdx` (Task 1), `PaginationQuery` from the contract package.
- Produces: `TenantCatalogRepository`, `createTenantCatalogService(repository)` returning `{ listDocumentTypes(context, tenantId, query?), getDocumentContract(context, tenantId, documentType, documentContractIdx) }`.

- [ ] **Step 1: Write the failing test**

Create `packages/portal-service/tests/tenant-catalog.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createTenantCatalogService, type TenantCatalogRepository, type TenantContext } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const contract = {
  documentType: "markdown", documentContractIdx: 0, formatVersion: 1,
  snapshot: { contentType: "application/vnd.unidocs.markdown.snapshot+cbor;version=1", schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" }, schemaHash: "sha256:snapshot" },
  location: { contentType: "application/vnd.unidocs.markdown.location+json;version=1", schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" }, schemaHash: "sha256:location" },
  contractHash: "sha256:contract", createdAt: "2026-09-11T00:00:00.000Z",
} as const;

function setup(overrides: Partial<TenantCatalogRepository> = {}) {
  const repository: TenantCatalogRepository = {
    listDocumentTypes: vi.fn(async () => ({ items: [], nextCursor: null })),
    getDocumentContract: vi.fn(async () => contract),
    ...overrides,
  };
  return { repository, service: createTenantCatalogService(repository) };
}

test("passes a bounded page query through to the repository", async () => {
  const { repository, service } = setup();
  await service.listDocumentTypes(context, "tenant-a", { limit: 10 });
  expect(repository.listDocumentTypes).toHaveBeenCalledWith(context, { limit: 10 });
});

test("refuses to list another tenant's catalog", async () => {
  const { repository, service } = setup();
  await expect(service.listDocumentTypes(context, "tenant-b")).rejects.toMatchObject({ code: "forbidden" });
  expect(repository.listDocumentTypes).not.toHaveBeenCalled();
});

test("reads any revision a version or location can name, not only the highest", async () => {
  const { repository, service } = setup();
  await expect(service.getDocumentContract(context, "tenant-a", "markdown", 0)).resolves.toEqual(contract);
  expect(repository.getDocumentContract).toHaveBeenCalledWith(context, "markdown", 0);
});

test.each(["PSD document", "", "-leading"])("rejects a document type that is not MIME-safe %#", async documentType => {
  const { repository, service } = setup();
  await expect(service.getDocumentContract(context, "tenant-a", documentType, 0)).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.getDocumentContract).not.toHaveBeenCalled();
});

test.each([-1, 1.5, "0"])("rejects a contract revision that is not zero-based %#", async idx => {
  const { service } = setup();
  await expect(service.getDocumentContract(context, "tenant-a", "markdown", idx as number)).rejects.toMatchObject({ code: "invalid_request" });
});

test("reports a missing revision as not found", async () => {
  const { service } = setup({ getDocumentContract: vi.fn(async () => null) });
  await expect(service.getDocumentContract(context, "tenant-a", "markdown", 7)).rejects.toMatchObject({ code: "not_found" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-catalog.test.ts
```

Expected: FAIL — `createTenantCatalogService` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/portal-service/src/tenant/catalog.ts`:

```ts
import { DocumentTypeSchema, type DocumentContractRecord, type ListPublicDocumentTypesResponse, type PaginationQuery } from "@unidocs/protocol-tenant-portal";
import { requirePagination, requireRecordIdx, requireTenantScope, TenantOperationError, type TenantContext } from "./access.js";

export interface TenantCatalogRepository {
  listDocumentTypes(context: TenantContext, query: PaginationQuery): Promise<ListPublicDocumentTypesResponse>;
  getDocumentContract(context: TenantContext, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord | null>;
}

export function createTenantCatalogService(repository: TenantCatalogRepository) {
  return {
    listDocumentTypes(context: TenantContext, tenantId: string, query: unknown = {}): Promise<ListPublicDocumentTypesResponse> {
      requireTenantScope(context, tenantId);
      return repository.listDocumentTypes(context, requirePagination(query));
    },

    async getDocumentContract(context: TenantContext, tenantId: string, documentType: string, documentContractIdx: number): Promise<DocumentContractRecord> {
      requireTenantScope(context, tenantId);
      if (!DocumentTypeSchema.safeParse(documentType).success) throw new TenantOperationError("invalid_request");
      const record = await repository.getDocumentContract(context, documentType, requireRecordIdx(documentContractIdx));
      if (!record) throw new TenantOperationError("not_found");
      return record;
    },
  };
}
```

Append to `packages/portal-service/src/index.ts`:

```ts
export { createTenantCatalogService } from "./tenant/catalog.js";
export type { TenantCatalogRepository } from "./tenant/catalog.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-catalog.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/portal-service/src/tenant/catalog.ts packages/portal-service/src/index.ts packages/portal-service/tests/tenant-catalog.test.ts
git commit -m "feat(tenant): read the enabled document type catalog

Any paired contract revision a version or location names can be read, not
only the highest: the highest index records the last append, and every
revision the current View and Operator both support stays writable."
```

---

### Task 3: Document creation and reads

**Files:**
- Create: `packages/portal-service/src/tenant/documents.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-documents.test.ts`

**Interfaces:**
- Consumes: Task 1 guards, `schemaHash` from `../identity.js`.
- Produces: `DocumentCreateCommand`, `CurrentVersionMoveCommand`, `TenantDocumentRepository`, `createTenantDocumentService(repository, options?)` returning `{ create, get, list, moveCurrentVersion, listAuditEvents }`. Task 4 fills in `moveCurrentVersion` and `listAuditEvents`; this task defines all five in the repository interface so the fake in both test files is identical.

- [ ] **Step 1: Write the failing test**

Create `packages/portal-service/tests/tenant-documents.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createTenantDocumentService, TENANT_LIMITS, type TenantContext, type TenantDocumentRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };

function setup(overrides: Partial<TenantDocumentRepository> = {}) {
  const repository: TenantDocumentRepository = {
    create: vi.fn(async command => command.document),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    moveCurrentVersion: vi.fn(async () => ({ documentId: "doc-1", name: "Notes", documentType: "markdown", currentVersionIdx: 3, createdAt: "2026-09-11T00:00:00.000Z" })),
    listAuditEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  };
  return {
    repository,
    service: createTenantDocumentService(repository, { now: () => new Date("2026-09-11T00:00:00.000Z"), id: () => "00000000-0000-4000-8000-000000000000" }),
  };
}

test("creates an uninitialised document and audits its creation", async () => {
  const { repository, service } = setup();
  const document = await service.create(context, "tenant-a", { documentType: "markdown", name: "Notes" }, "retry-1", "request-1");
  expect(document).toMatchObject({ documentId: "doc-00000000-0000-4000-8000-000000000000", name: "Notes", documentType: "markdown", currentVersionIdx: null });
  const [command] = vi.mocked(repository.create).mock.calls[0];
  expect(command.key).toBe("retry-1");
  expect(command.audit).toMatchObject({ actorId: "user-1", action: "document.created", beforeVersionIdx: null, afterVersionIdx: null, reason: null, requestId: "request-1" });
});

test("the idempotency fingerprint covers the operation and the request body", async () => {
  const { repository, service } = setup();
  await service.create(context, "tenant-a", { documentType: "markdown", name: "Notes" }, "retry-1", "request-1");
  await service.create(context, "tenant-a", { documentType: "markdown", name: "Other" }, "retry-1", "request-2");
  const [first] = vi.mocked(repository.create).mock.calls[0];
  const [second] = vi.mocked(repository.create).mock.calls[1];
  expect(first.fingerprint).not.toBe(second.fingerprint);
});

test.each([
  {},
  { documentType: "markdown" },
  { documentType: "markdown", name: "" },
  { documentType: "markdown", name: "   " },
  { documentType: "markdown", name: "a".repeat(TENANT_LIMITS.documentName + 1) },
  { documentType: "PSD document", name: "Notes" },
  { documentType: "markdown", name: "Notes", currentVersionIdx: 0 },
])("rejects invalid creation input %# before persistence", async body => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", body, "retry-1", "request-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("a missing idempotency key is rejected, because a retry would create a second document", async () => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", { documentType: "markdown", name: "Notes" }, "", "request-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("reports a missing document as not found", async () => {
  const { service } = setup();
  await expect(service.get(context, "tenant-a", "doc-missing")).rejects.toMatchObject({ code: "not_found" });
});

test("filters the document list by document type only when one is supplied", async () => {
  const { repository, service } = setup();
  await service.list(context, "tenant-a", {});
  expect(repository.list).toHaveBeenCalledWith(context, {});
  await service.list(context, "tenant-a", { documentType: "markdown", limit: 5 });
  expect(repository.list).toHaveBeenLastCalledWith(context, { limit: 5, documentType: "markdown" });
  await expect(service.list(context, "tenant-a", { documentType: "PSD document" })).rejects.toMatchObject({ code: "invalid_request" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-documents.test.ts
```

Expected: FAIL — `createTenantDocumentService` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/portal-service/src/tenant/documents.ts`:

```ts
import {
  CreateDocumentRequestSchema, DocumentAuditEventSchema, DocumentRecordSchema, DocumentTypeSchema, MoveCurrentVersionRequestSchema,
  type DocumentAuditEvent, type DocumentRecord, type ListDocumentAuditEventsResponse, type ListDocumentsQuery, type ListDocumentsResponse, type PaginationQuery,
} from "@unidocs/protocol-tenant-portal";
import { schemaHash } from "../identity.js";
import {
  requireExactFields, requireIdempotencyKey, requireIdentifier, requirePagination, requireTenantScope,
  TENANT_LIMITS, TenantOperationError, type TenantContext,
} from "./access.js";

export interface DocumentCreateCommand {
  readonly context: TenantContext;
  readonly key: string;
  readonly fingerprint: string;
  readonly document: DocumentRecord;
  readonly audit: DocumentAuditEvent;
}

/**
 * The equality lock travels with the command: the repository must refuse the
 * move unless the pointer still equals observedCurrentVersionIdx at commit, and
 * must write the audit event in the same transaction as the move.
 */
export interface CurrentVersionMoveCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly observedCurrentVersionIdx: number | null;
  readonly targetVersionIdx: number;
  readonly audit: DocumentAuditEvent;
}

export interface TenantDocumentRepository {
  create(command: DocumentCreateCommand): Promise<DocumentRecord>;
  get(context: TenantContext, documentId: string): Promise<DocumentRecord | null>;
  list(context: TenantContext, query: ListDocumentsQuery): Promise<ListDocumentsResponse>;
  moveCurrentVersion(command: CurrentVersionMoveCommand): Promise<DocumentRecord>;
  listAuditEvents(context: TenantContext, documentId: string, query: PaginationQuery): Promise<ListDocumentAuditEventsResponse>;
}

export function createTenantDocumentService(repository: TenantDocumentRepository, options: {
  readonly now?: () => Date;
  readonly id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());

  return {
    async create(context: TenantContext, tenantId: string, body: unknown, key: string, requestId: string): Promise<DocumentRecord> {
      requireTenantScope(context, tenantId);
      const idempotencyKey = requireIdempotencyKey(key);
      requireExactFields(body, ["documentType", "name"]);
      const parsed = CreateDocumentRequestSchema.safeParse(body);
      if (!parsed.success || !parsed.data.name.trim() || parsed.data.name.length > TENANT_LIMITS.documentName) throw new TenantOperationError("invalid_request");
      const occurredAt = now().toISOString();
      const document = DocumentRecordSchema.parse({
        documentId: `doc-${id()}`, name: parsed.data.name, documentType: parsed.data.documentType, currentVersionIdx: null, createdAt: occurredAt,
      });
      return repository.create({
        context, key: idempotencyKey, fingerprint: await schemaHash({ operation: "createDocument", body: parsed.data }), document,
        audit: DocumentAuditEventSchema.parse({
          auditEventId: id(), actorId: context.principalId, action: "document.created",
          beforeVersionIdx: null, afterVersionIdx: null, reason: null, requestId, occurredAt,
        }),
      });
    },

    async get(context: TenantContext, tenantId: string, documentId: string): Promise<DocumentRecord> {
      requireTenantScope(context, tenantId);
      const document = await repository.get(context, requireIdentifier(documentId));
      if (!document) throw new TenantOperationError("not_found");
      return document;
    },

    list(context: TenantContext, tenantId: string, query: ListDocumentsQuery = {}): Promise<ListDocumentsResponse> {
      requireTenantScope(context, tenantId);
      const page = requirePagination({ cursor: query.cursor, limit: query.limit });
      if (query.documentType !== undefined && !DocumentTypeSchema.safeParse(query.documentType).success) throw new TenantOperationError("invalid_request");
      return repository.list(context, { ...page, ...(query.documentType === undefined ? {} : { documentType: query.documentType }) });
    },

    async moveCurrentVersion(context: TenantContext, tenantId: string, documentId: string, body: unknown, requestId: string): Promise<DocumentRecord> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      requireExactFields(body, ["observedCurrentVersionIdx", "targetVersionIdx", "reason"]);
      const parsed = MoveCurrentVersionRequestSchema.safeParse(body);
      if (!parsed.success || !parsed.data.reason.trim() || parsed.data.reason.length > TENANT_LIMITS.reason) throw new TenantOperationError("invalid_request");
      return repository.moveCurrentVersion({
        context, documentId: document,
        observedCurrentVersionIdx: parsed.data.observedCurrentVersionIdx, targetVersionIdx: parsed.data.targetVersionIdx,
        audit: DocumentAuditEventSchema.parse({
          auditEventId: id(), actorId: context.principalId, action: "current_version.moved",
          beforeVersionIdx: parsed.data.observedCurrentVersionIdx, afterVersionIdx: parsed.data.targetVersionIdx,
          reason: parsed.data.reason, requestId, occurredAt: now().toISOString(),
        }),
      });
    },

    listAuditEvents(context: TenantContext, tenantId: string, documentId: string, query: unknown = {}): Promise<ListDocumentAuditEventsResponse> {
      requireTenantScope(context, tenantId);
      return repository.listAuditEvents(context, requireIdentifier(documentId), requirePagination(query));
    },
  };
}
```

Append to `packages/portal-service/src/index.ts`:

```ts
export { createTenantDocumentService } from "./tenant/documents.js";
export type { CurrentVersionMoveCommand, DocumentCreateCommand, TenantDocumentRepository } from "./tenant/documents.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-documents.test.ts
```

Expected: PASS. `moveCurrentVersion` and `listAuditEvents` are implemented here but are not yet covered by tests; Task 4 adds those.

- [ ] **Step 5: Commit**

```bash
git add packages/portal-service/src/tenant/documents.ts packages/portal-service/src/index.ts packages/portal-service/tests/tenant-documents.test.ts
git commit -m "feat(tenant): create and read documents

A new document points at no version: it becomes openable only once its
Operator commits the first snapshot. Creation therefore carries an
idempotency key, because a retried create would otherwise leave a second
empty document behind that nothing would ever clean up."
```

---

### Task 4: Current pointer move and document audit

**Files:**
- Modify: `packages/portal-service/src/tenant/documents.ts` (no code change expected; verify against tests)
- Test: `packages/portal-service/tests/tenant-current-version.test.ts`

**Interfaces:**
- Consumes: `createTenantDocumentService`, `TenantDocumentRepository`, `CurrentVersionMoveCommand` (Task 3).
- Produces: nothing new; this task proves the equality lock and audit shape.

- [ ] **Step 1: Write the failing test**

Create `packages/portal-service/tests/tenant-current-version.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createTenantDocumentService, TENANT_LIMITS, type TenantContext, type TenantDocumentRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const moved = { documentId: "doc-1", name: "Notes", documentType: "markdown", currentVersionIdx: 3, createdAt: "2026-09-11T00:00:00.000Z" };

function setup(overrides: Partial<TenantDocumentRepository> = {}) {
  const repository: TenantDocumentRepository = {
    create: vi.fn(async command => command.document),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    moveCurrentVersion: vi.fn(async () => moved),
    listAuditEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  };
  return {
    repository,
    service: createTenantDocumentService(repository, { now: () => new Date("2026-09-11T00:00:00.000Z"), id: () => "00000000-0000-4000-8000-000000000000" }),
  };
}

test("carries the equality lock and both pointer positions into the audit event", async () => {
  const { repository, service } = setup();
  await service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "Restore the reviewed draft" }, "request-1");
  const [command] = vi.mocked(repository.moveCurrentVersion).mock.calls[0];
  expect(command).toMatchObject({ documentId: "doc-1", observedCurrentVersionIdx: 7, targetVersionIdx: 3 });
  expect(command.audit).toMatchObject({
    actorId: "user-1", action: "current_version.moved", beforeVersionIdx: 7, afterVersionIdx: 3,
    reason: "Restore the reviewed draft", requestId: "request-1", occurredAt: "2026-09-11T00:00:00.000Z",
  });
});

test("accepts a null lock, which is how the very first pointer is set", async () => {
  const { repository, service } = setup();
  await service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: null, targetVersionIdx: 0, reason: "Adopt the initial snapshot" }, "request-1");
  const [command] = vi.mocked(repository.moveCurrentVersion).mock.calls[0];
  expect(command.observedCurrentVersionIdx).toBeNull();
  expect(command.audit.beforeVersionIdx).toBeNull();
});

test.each([
  { targetVersionIdx: 3, reason: "why" },
  { observedCurrentVersionIdx: 7, reason: "why" },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3 },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "" },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "a".repeat(TENANT_LIMITS.reason + 1) },
  { observedCurrentVersionIdx: 7, targetVersionIdx: -1, reason: "why" },
  { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "why", force: true },
])("rejects an unusable move request %# before the lock is attempted", async body => {
  const { repository, service } = setup();
  await expect(service.moveCurrentVersion(context, "tenant-a", "doc-1", body, "request-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.moveCurrentVersion).not.toHaveBeenCalled();
});

test("the move takes no idempotency key, because the equality lock already makes a retry safe", async () => {
  const { service } = setup();
  await expect(service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "why" }, "request-1")).resolves.toEqual(moved);
});

test("surfaces the repository's lock failure unchanged", async () => {
  const { service } = setup({ moveCurrentVersion: vi.fn(async () => { throw Object.assign(new Error("stale"), { code: "version_conflict" }); }) });
  await expect(service.moveCurrentVersion(context, "tenant-a", "doc-1", { observedCurrentVersionIdx: 7, targetVersionIdx: 3, reason: "why" }, "request-1")).rejects.toMatchObject({ code: "version_conflict" });
});

test("pages document audit events and refuses another tenant's document", async () => {
  const { repository, service } = setup();
  await service.listAuditEvents(context, "tenant-a", "doc-1", { limit: 20 });
  expect(repository.listAuditEvents).toHaveBeenCalledWith(context, "doc-1", { limit: 20 });
  await expect(service.listAuditEvents(context, "tenant-b", "doc-1")).rejects.toMatchObject({ code: "forbidden" });
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-current-version.test.ts
```

Expected: PASS if Task 3's implementation is correct. If any case fails, fix `moveCurrentVersion` or `listAuditEvents` in `src/tenant/documents.ts` until it passes — do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add packages/portal-service/tests/tenant-current-version.test.ts packages/portal-service/src/tenant/documents.ts
git commit -m "test(tenant): pin the current-pointer lock and its audit shape

Moving the pointer changes the base of later versions, the resolution of
indirect references, and the optimistic-locking baseline Agent submissions
build on, so both pointer positions and the actor's reason must reach the
audit event in the same command the repository commits."
```

---

### Task 5: Version metadata and snapshot bytes

**Files:**
- Create: `packages/portal-service/src/tenant/versions.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-versions.test.ts`

**Interfaces:**
- Consumes: Task 1 guards, `documentSnapshotContentType` from `@unidocs/protocol-tenant-portal`.
- Produces: `VersionSnapshot`, `TenantVersionRepository`, `createTenantVersionService(repository)` returning `{ list, get, getSnapshot }`. `getSnapshot` resolves to `{ contentType: string; body: ReadableStream<Uint8Array> }`.

- [ ] **Step 1: Write the failing test**

Create `packages/portal-service/tests/tenant-versions.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createTenantVersionService, type TenantContext, type TenantVersionRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const version = {
  versionIdx: 7, parentVersionIdx: 6, documentContractIdx: 0, authorAgentId: "op-markdown",
  submissionId: "sub-1", addressedComments: [{ threadId: "th-2", commentIdx: 3, baseVersionIdx: 5 }],
  createdAt: "2026-09-11T00:00:00.000Z",
};
const body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });

function setup(overrides: Partial<TenantVersionRepository> = {}) {
  const repository: TenantVersionRepository = {
    list: vi.fn(async () => ({ items: [version], nextCursor: null })),
    get: vi.fn(async () => version),
    readSnapshot: vi.fn(async () => ({ documentType: "markdown", body: body() })),
    ...overrides,
  };
  return { repository, service: createTenantVersionService(repository) };
}

test("version metadata carries both graphs and never the snapshot", async () => {
  const { service } = setup();
  const record = await service.get(context, "tenant-a", "doc-1", 7);
  expect(record).toMatchObject({ parentVersionIdx: 6, addressedComments: [{ threadId: "th-2", commentIdx: 3, baseVersionIdx: 5 }] });
  expect(record).not.toHaveProperty("snapshot");
});

test("derives the snapshot media type from the document type rather than trusting a stored string", async () => {
  const { service } = setup();
  const snapshot = await service.getSnapshot(context, "tenant-a", "doc-1", 7);
  expect(snapshot.contentType).toBe("application/vnd.unidocs.markdown.snapshot+cbor;version=1");
  expect(snapshot.body).toBeInstanceOf(ReadableStream);
});

test("rejects a document type the media type cannot be derived from", async () => {
  const { service } = setup({ readSnapshot: vi.fn(async () => ({ documentType: "PSD document", body: body() })) });
  await expect(service.getSnapshot(context, "tenant-a", "doc-1", 7)).rejects.toMatchObject({ code: "content_unavailable" });
});

test("reports missing versions and missing snapshot bytes distinctly", async () => {
  const missingVersion = setup({ get: vi.fn(async () => null) });
  await expect(missingVersion.service.get(context, "tenant-a", "doc-1", 7)).rejects.toMatchObject({ code: "not_found" });
  const missingSnapshot = setup({ readSnapshot: vi.fn(async () => null) });
  await expect(missingSnapshot.service.getSnapshot(context, "tenant-a", "doc-1", 7)).rejects.toMatchObject({ code: "not_found" });
});

test.each([-1, 1.5, "7"])("rejects a version index that is not zero-based %#", async versionIdx => {
  const { repository, service } = setup();
  await expect(service.get(context, "tenant-a", "doc-1", versionIdx as number)).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.get).not.toHaveBeenCalled();
});

test("pages version metadata and refuses another tenant's document", async () => {
  const { repository, service } = setup();
  await service.list(context, "tenant-a", "doc-1", { limit: 50 });
  expect(repository.list).toHaveBeenCalledWith(context, "doc-1", { limit: 50 });
  await expect(service.list(context, "tenant-b", "doc-1")).rejects.toMatchObject({ code: "forbidden" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-versions.test.ts
```

Expected: FAIL — `createTenantVersionService` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/portal-service/src/tenant/versions.ts`:

```ts
import { documentSnapshotContentType, type ListVersionsResponse, type PaginationQuery, type VersionRecord } from "@unidocs/protocol-tenant-portal";
import { requireIdentifier, requirePagination, requireRecordIdx, requireTenantScope, TenantOperationError, type TenantContext } from "./access.js";

/**
 * Snapshot bytes leave storage with the document type rather than a media type
 * string, so the wire content type is always derived and never free-form.
 */
export interface VersionSnapshot {
  readonly documentType: string;
  readonly body: ReadableStream<Uint8Array>;
}

export interface TenantVersionRepository {
  list(context: TenantContext, documentId: string, query: PaginationQuery): Promise<ListVersionsResponse>;
  get(context: TenantContext, documentId: string, versionIdx: number): Promise<VersionRecord | null>;
  readSnapshot(context: TenantContext, documentId: string, versionIdx: number): Promise<VersionSnapshot | null>;
}

export function createTenantVersionService(repository: TenantVersionRepository) {
  return {
    list(context: TenantContext, tenantId: string, documentId: string, query: unknown = {}): Promise<ListVersionsResponse> {
      requireTenantScope(context, tenantId);
      return repository.list(context, requireIdentifier(documentId), requirePagination(query));
    },

    async get(context: TenantContext, tenantId: string, documentId: string, versionIdx: number): Promise<VersionRecord> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const idx = requireRecordIdx(versionIdx);
      const record = await repository.get(context, document, idx);
      if (!record) throw new TenantOperationError("not_found");
      return record;
    },

    async getSnapshot(context: TenantContext, tenantId: string, documentId: string, versionIdx: number): Promise<{ readonly contentType: string; readonly body: ReadableStream<Uint8Array> }> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const idx = requireRecordIdx(versionIdx);
      const snapshot = await repository.readSnapshot(context, document, idx);
      if (!snapshot) throw new TenantOperationError("not_found");
      try {
        return { contentType: documentSnapshotContentType(snapshot.documentType), body: snapshot.body };
      } catch {
        throw new TenantOperationError("content_unavailable");
      }
    },
  };
}
```

Append to `packages/portal-service/src/index.ts`:

```ts
export { createTenantVersionService } from "./tenant/versions.js";
export type { TenantVersionRepository, VersionSnapshot } from "./tenant/versions.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-versions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/portal-service/src/tenant/versions.ts packages/portal-service/src/index.ts packages/portal-service/tests/tenant-versions.test.ts
git commit -m "feat(tenant): read version metadata and snapshot bytes separately

An SValue carries atomic SBlob references that have no JSON representation,
so the snapshot crosses the wire as canonical CBOR from its own operation
while metadata stays JSON. The media type is derived from the document type
at read time rather than trusted from storage, so a corrupted row cannot
put a free-form content type on the wire."
```

---

### Task 6: Thread creation with anchor and location checking

**Files:**
- Create: `packages/portal-service/src/tenant/threads.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-threads.test.ts`

**Interfaces:**
- Consumes: Task 1 guards, `schemaHash` from `../identity.js`.
- Produces: `CommentAnchor`, `DocumentLocationValidator`, `ThreadCreateCommand`, `CommentAppendCommand`, `TenantThreadRepository`, `createTenantThreadService(repository, { validateLocation })` returning `{ list, create, get, appendComment }`. Task 7 tests `appendComment`, `list` and `get`; this task defines all four.

- [ ] **Step 1: Write the failing test**

Create `packages/portal-service/tests/tenant-threads.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createTenantThreadService, TENANT_LIMITS, type TenantContext, type TenantThreadRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const locationSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1" } as const;
const location = { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 120, end: 180 } };
const content = { text: "Please shorten this", richContent: null, attachments: [] };
const comment = { commentIdx: 0, baseVersionIdx: 5, content, location, authorId: "user-1", createdAt: "2026-09-11T00:00:00.000Z" };
const thread = { threadId: "th-1", comments: [comment], replies: [] };

function setup(overrides: Partial<TenantThreadRepository> = {}, validateLocation = vi.fn(() => true)) {
  const repository: TenantThreadRepository = {
    loadCommentAnchor: vi.fn(async () => ({ documentContractIdx: 0, locationSchema })),
    list: vi.fn(async () => ({ items: [{ threadId: "th-1" }], nextCursor: null })),
    create: vi.fn(async () => thread),
    get: vi.fn(async () => thread),
    appendComment: vi.fn(async () => comment),
    ...overrides,
  };
  return { repository, validateLocation, service: createTenantThreadService(repository, { validateLocation }) };
}

test("anchors a new thread to an existing version and fingerprints the request", async () => {
  const { repository, service } = setup();
  await service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location }, "retry-1");
  expect(repository.loadCommentAnchor).toHaveBeenCalledWith(context, "doc-1", 5);
  const [command] = vi.mocked(repository.create).mock.calls[0];
  expect(command).toMatchObject({ documentId: "doc-1", key: "retry-1" });
  expect(command.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("a comment does not have to be based on current, so an older base version is accepted", async () => {
  const { repository, service } = setup();
  await service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 0, content, location: null }, "retry-1");
  expect(repository.loadCommentAnchor).toHaveBeenCalledWith(context, "doc-1", 0);
  expect(repository.create).toHaveBeenCalled();
});

test("reports an unknown base version as not found rather than inventing one", async () => {
  const { repository, service } = setup({ loadCommentAnchor: vi.fn(async () => null) });
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 99, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "not_found" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("a location must name the same contract revision as the version it anchors to", async () => {
  const { repository, service } = setup();
  const mismatched = { ...location, documentContractIdx: 1 };
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: mismatched }, "retry-1")).rejects.toMatchObject({ code: "location_contract_violation" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("a location must pass that revision's location schema", async () => {
  const validateLocation = vi.fn(() => false);
  const { repository, service } = setup({}, validateLocation);
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location }, "retry-1")).rejects.toMatchObject({ code: "location_contract_violation" });
  expect(validateLocation).toHaveBeenCalledWith(location, locationSchema);
  expect(repository.create).not.toHaveBeenCalled();
});

test("a document-level thread carries no location and needs no schema check", async () => {
  const { validateLocation, service } = setup();
  await service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: null }, "retry-1");
  expect(validateLocation).not.toHaveBeenCalled();
});

test("attachments cannot replace the body", async () => {
  const { repository, service } = setup();
  const empty = { text: null, richContent: null, attachments: [{ blobHash: "b3:9f2c", size: 12, contentType: "image/webp" }] };
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content: empty, location: null }, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test.each([
  { text: "a".repeat(TENANT_LIMITS.messageText + 1), richContent: null, attachments: [] },
  { text: "ok", richContent: null, attachments: Array.from({ length: TENANT_LIMITS.attachments + 1 }, () => ({ blobHash: "b3:9f2c", size: 1, contentType: "image/webp" })) },
])("rejects a message beyond its bounds %#", async oversized => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content: oversized, location: null }, "retry-1")).rejects.toMatchObject({ code: "limit_exceeded" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("rejects a location payload larger than the bound", async () => {
  const { service } = setup();
  const huge = { ...location, payload: { note: "a".repeat(TENANT_LIMITS.locationPayloadBytes + 1) } };
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: huge }, "retry-1")).rejects.toMatchObject({ code: "limit_exceeded" });
});

test.each([
  { content, location: null },
  { baseVersionIdx: -1, content, location: null },
  { baseVersionIdx: 5, location: null },
  { baseVersionIdx: 5, content, location: null, threadId: "th-1" },
])("rejects an unusable thread request %#", async body => {
  const { repository, service } = setup();
  await expect(service.create(context, "tenant-a", "doc-1", body, "retry-1")).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.create).not.toHaveBeenCalled();
});

test("thread creation requires an idempotency key", async () => {
  const { service } = setup();
  await expect(service.create(context, "tenant-a", "doc-1", { baseVersionIdx: 5, content, location: null }, "")).rejects.toMatchObject({ code: "invalid_request" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-threads.test.ts
```

Expected: FAIL — `createTenantThreadService` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/portal-service/src/tenant/threads.ts`:

```ts
import {
  AppendCommentRequestSchema, CreateThreadRequestSchema,
  type AppendCommentRequest, type CommentRecord, type CreateThreadRequest, type DocumentLocation,
  type ListThreadsQuery, type ListThreadsResponse, type SValueSchema, type ThreadDetail,
} from "@unidocs/protocol-tenant-portal";
import { canonicalJson, schemaHash } from "../identity.js";
import {
  requireExactFields, requireIdempotencyKey, requireIdentifier, requirePagination, requireRecordIdx, requireTenantScope,
  TENANT_LIMITS, TenantOperationError, type TenantContext,
} from "./access.js";

/** What the base version fixes for any location written against it. */
export interface CommentAnchor {
  readonly documentContractIdx: number;
  readonly locationSchema: SValueSchema;
}

/** Supplied by the adapter; there is deliberately no default, so it cannot be skipped silently. */
export type DocumentLocationValidator = (location: DocumentLocation, schema: SValueSchema) => boolean;

export interface ThreadCreateCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly request: CreateThreadRequest;
}

export interface CommentAppendCommand {
  readonly context: TenantContext;
  readonly documentId: string;
  readonly threadId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly request: AppendCommentRequest;
}

export interface TenantThreadRepository {
  loadCommentAnchor(context: TenantContext, documentId: string, baseVersionIdx: number): Promise<CommentAnchor | null>;
  list(context: TenantContext, documentId: string, query: ListThreadsQuery): Promise<ListThreadsResponse>;
  create(command: ThreadCreateCommand): Promise<ThreadDetail>;
  get(context: TenantContext, documentId: string, threadId: string): Promise<ThreadDetail | null>;
  appendComment(command: CommentAppendCommand): Promise<CommentRecord>;
}

function requireBoundedMessage(request: { readonly content: { readonly text: string | null; readonly attachments: readonly unknown[] }; readonly location: DocumentLocation | null }): void {
  if ((request.content.text?.length ?? 0) > TENANT_LIMITS.messageText || request.content.attachments.length > TENANT_LIMITS.attachments) throw new TenantOperationError("limit_exceeded");
  if (request.location && new TextEncoder().encode(canonicalJson(request.location.payload)).byteLength > TENANT_LIMITS.locationPayloadBytes) throw new TenantOperationError("limit_exceeded");
}

export function createTenantThreadService(repository: TenantThreadRepository, options: { readonly validateLocation: DocumentLocationValidator }) {
  async function anchor(context: TenantContext, documentId: string, request: { readonly baseVersionIdx: number; readonly location: DocumentLocation | null }): Promise<void> {
    const found = await repository.loadCommentAnchor(context, documentId, request.baseVersionIdx);
    if (!found) throw new TenantOperationError("not_found");
    if (!request.location) return;
    if (request.location.documentContractIdx !== found.documentContractIdx) throw new TenantOperationError("location_contract_violation");
    if (!options.validateLocation(request.location, found.locationSchema)) throw new TenantOperationError("location_contract_violation");
  }

  return {
    list(context: TenantContext, tenantId: string, documentId: string, query: ListThreadsQuery = {}): Promise<ListThreadsResponse> {
      requireTenantScope(context, tenantId);
      const page = requirePagination({ cursor: query.cursor, limit: query.limit });
      if (query.open !== undefined && typeof query.open !== "boolean") throw new TenantOperationError("invalid_request");
      if (query.versionIdx !== undefined) requireRecordIdx(query.versionIdx);
      return repository.list(context, requireIdentifier(documentId), {
        ...page,
        ...(query.open === undefined ? {} : { open: query.open }),
        ...(query.versionIdx === undefined ? {} : { versionIdx: query.versionIdx }),
      });
    },

    async create(context: TenantContext, tenantId: string, documentId: string, body: unknown, key: string): Promise<ThreadDetail> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const idempotencyKey = requireIdempotencyKey(key);
      requireExactFields(body, ["baseVersionIdx", "content", "location"]);
      const parsed = CreateThreadRequestSchema.safeParse(body);
      if (!parsed.success) throw new TenantOperationError("invalid_request");
      requireBoundedMessage(parsed.data);
      await anchor(context, document, parsed.data);
      return repository.create({
        context, documentId: document, key: idempotencyKey,
        fingerprint: await schemaHash({ operation: "createThread", body: parsed.data }), request: parsed.data,
      });
    },

    async get(context: TenantContext, tenantId: string, documentId: string, threadId: string): Promise<ThreadDetail> {
      requireTenantScope(context, tenantId);
      const detail = await repository.get(context, requireIdentifier(documentId), requireIdentifier(threadId));
      if (!detail) throw new TenantOperationError("not_found");
      return detail;
    },

    async appendComment(context: TenantContext, tenantId: string, documentId: string, threadId: string, body: unknown, key: string): Promise<CommentRecord> {
      requireTenantScope(context, tenantId);
      const document = requireIdentifier(documentId);
      const thread = requireIdentifier(threadId);
      const idempotencyKey = requireIdempotencyKey(key);
      requireExactFields(body, ["baseVersionIdx", "content", "location"]);
      const parsed = AppendCommentRequestSchema.safeParse(body);
      if (!parsed.success) throw new TenantOperationError("invalid_request");
      requireBoundedMessage(parsed.data);
      await anchor(context, document, parsed.data);
      return repository.appendComment({
        context, documentId: document, threadId: thread, key: idempotencyKey,
        fingerprint: await schemaHash({ operation: "appendComment", threadId: thread, body: parsed.data }), request: parsed.data,
      });
    },
  };
}
```

Append to `packages/portal-service/src/index.ts`:

```ts
export { createTenantThreadService } from "./tenant/threads.js";
export type { CommentAnchor, CommentAppendCommand, DocumentLocationValidator, TenantThreadRepository, ThreadCreateCommand } from "./tenant/threads.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-threads.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/portal-service/src/tenant/threads.ts packages/portal-service/src/index.ts packages/portal-service/tests/tenant-threads.test.ts
git commit -m "feat(tenant): create threads against a checked version anchor

A location is meaningful only relative to the version it was written
against, so the base version fixes both the contract revision the location
must name and the schema it must satisfy. The schema validator is a required
dependency rather than a defaulted one: an accepting default would let an
unvalidated location reach storage without anyone noticing."
```

---

### Task 7: Comment append and thread reads

**Files:**
- Modify: `packages/portal-service/src/tenant/threads.ts` (no code change expected; verify against tests)
- Test: `packages/portal-service/tests/tenant-comments.test.ts`

**Interfaces:**
- Consumes: `createTenantThreadService`, `TenantThreadRepository`, `CommentAppendCommand` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `packages/portal-service/tests/tenant-comments.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createTenantThreadService, type TenantContext, type TenantThreadRepository } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const locationSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1" } as const;
const content = { text: "Still too long", richContent: null, attachments: [] };
const comment = { commentIdx: 3, baseVersionIdx: 7, content, location: null, authorId: "user-1", createdAt: "2026-09-11T00:00:00.000Z" };
const thread = { threadId: "th-1", comments: [comment], replies: [] };

function setup(overrides: Partial<TenantThreadRepository> = {}) {
  const repository: TenantThreadRepository = {
    loadCommentAnchor: vi.fn(async () => ({ documentContractIdx: 0, locationSchema })),
    list: vi.fn(async () => ({ items: [{ threadId: "th-1" }], nextCursor: null })),
    create: vi.fn(async () => thread),
    get: vi.fn(async () => thread),
    appendComment: vi.fn(async () => comment),
    ...overrides,
  };
  return { repository, service: createTenantThreadService(repository, { validateLocation: () => true }) };
}

test("appends a comment to an existing thread and returns the stored record", async () => {
  const { repository, service } = setup();
  const record = await service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-1");
  expect(record).toEqual(comment);
  const [command] = vi.mocked(repository.appendComment).mock.calls[0];
  expect(command).toMatchObject({ documentId: "doc-1", threadId: "th-1", key: "retry-1" });
});

test("the fingerprint distinguishes the same body appended to different threads", async () => {
  const { repository, service } = setup();
  await service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 7, content, location: null }, "retry-1");
  await service.appendComment(context, "tenant-a", "doc-1", "th-2", { baseVersionIdx: 7, content, location: null }, "retry-1");
  const [first] = vi.mocked(repository.appendComment).mock.calls[0];
  const [second] = vi.mocked(repository.appendComment).mock.calls[1];
  expect(first.fingerprint).not.toBe(second.fingerprint);
});

test("appending checks the anchor, so a comment cannot name a version that does not exist", async () => {
  const { repository, service } = setup({ loadCommentAnchor: vi.fn(async () => null) });
  await expect(service.appendComment(context, "tenant-a", "doc-1", "th-1", { baseVersionIdx: 99, content, location: null }, "retry-1")).rejects.toMatchObject({ code: "not_found" });
  expect(repository.appendComment).not.toHaveBeenCalled();
});

test("there is no edit, delete or withdraw operation on the service surface", () => {
  const { service } = setup();
  expect(Object.keys(service).sort()).toEqual(["appendComment", "create", "get", "list"]);
});

test("reads both message sequences of a thread", async () => {
  const { service } = setup();
  await expect(service.get(context, "tenant-a", "doc-1", "th-1")).resolves.toEqual(thread);
  const missing = setup({ get: vi.fn(async () => null) });
  await expect(missing.service.get(context, "tenant-a", "doc-1", "th-9")).rejects.toMatchObject({ code: "not_found" });
});

test("passes the derived open filter and version filter through untouched", async () => {
  const { repository, service } = setup();
  await service.list(context, "tenant-a", "doc-1", { open: true, versionIdx: 5, limit: 10 });
  expect(repository.list).toHaveBeenCalledWith(context, "doc-1", { limit: 10, open: true, versionIdx: 5 });
  await service.list(context, "tenant-a", "doc-1", {});
  expect(repository.list).toHaveBeenLastCalledWith(context, "doc-1", {});
});

test.each([{ open: "true" }, { versionIdx: -1 }, { limit: 0 }])("rejects an unusable thread filter %#", async query => {
  const { repository, service } = setup();
  await expect(service.list(context, "tenant-a", "doc-1", query as never)).rejects.toMatchObject({ code: "invalid_request" });
  expect(repository.list).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-comments.test.ts
```

Expected: PASS if Task 6's implementation is correct. If any case fails, fix `src/tenant/threads.ts` until it passes — do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add packages/portal-service/tests/tenant-comments.test.ts packages/portal-service/src/tenant/threads.ts
git commit -m "test(tenant): pin comment append and the absence of an edit path

Appending past the reply watermark is the only way a discussion reopens, so
the append path must check the anchor exactly as thread creation does. The
service surface is asserted whole to keep an edit, delete or withdraw
operation from appearing later without the protocol defining what it means."
```

---

### Task 8: UniCAS capability issuance

**Files:**
- Create: `packages/portal-service/src/tenant/cas.ts`
- Modify: `packages/portal-service/src/index.ts`
- Test: `packages/portal-service/tests/tenant-cas.test.ts`

**Interfaces:**
- Consumes: Task 1 guards, `CasCapabilityGrantSchema` from `@unidocs/protocol-tenant-portal`.
- Produces: `CasCapabilityIssuer`, `createTenantCasService(issuer, options?)` returning `{ issue(context, tenantId) }`.

- [ ] **Step 1: Write the failing test**

Create `packages/portal-service/tests/tenant-cas.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { createTenantCasService, type CasCapabilityIssuer, type TenantContext } from "../src/index.js";

const context: TenantContext = { tenantId: "tenant-a", principalId: "user-1", transport: "session" };
const grant = {
  baseUrl: "https://cas.example/", stackId: "stack-1", tenantId: "tenant-a",
  accessToken: "header.payload.signature", expiresAt: 2_000, permissions: ["cas:read", "cas:write"] as const,
};

function setup(issue: CasCapabilityIssuer["issue"] = vi.fn(async () => grant)) {
  const issuer: CasCapabilityIssuer = { issue };
  return { issuer, service: createTenantCasService(issuer, { now: () => 1_000 }) };
}

test("issues a tenant-scoped read and write capability", async () => {
  const { issuer, service } = setup();
  await expect(service.issue(context, "tenant-a")).resolves.toEqual(grant);
  expect(issuer.issue).toHaveBeenCalledWith(context);
});

test("refuses a grant issued for a different tenant than the caller", async () => {
  const { service } = setup(vi.fn(async () => ({ ...grant, tenantId: "tenant-b" })));
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "forbidden" });
});

test("refuses a grant that is already expired", async () => {
  const { service } = setup(vi.fn(async () => ({ ...grant, expiresAt: 999 })));
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "unavailable" });
});

test.each([
  { ...grant, permissions: ["cas:read"] },
  { ...grant, permissions: ["cas:read", "cas:write", "cas:manage"] },
  { ...grant, accessToken: "" },
  { ...grant, baseUrl: "not-a-url" },
])("refuses a malformed grant %#", async malformed => {
  const { service } = setup(vi.fn(async () => malformed as never));
  await expect(service.issue(context, "tenant-a")).rejects.toMatchObject({ code: "unavailable" });
});

test("refuses to issue against another tenant's path", async () => {
  const { issuer, service } = setup();
  await expect(service.issue(context, "tenant-b")).rejects.toMatchObject({ code: "forbidden" });
  expect(issuer.issue).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-cas.test.ts
```

Expected: FAIL — `createTenantCasService` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/portal-service/src/tenant/cas.ts`:

```ts
import { CasCapabilityGrantSchema, type CasCapabilityGrant } from "@unidocs/protocol-tenant-portal";
import { requireTenantScope, TenantOperationError, type TenantContext } from "./access.js";

/** The Platform mints these; it never proxies UniCAS node traffic itself. */
export interface CasCapabilityIssuer {
  issue(context: TenantContext): Promise<CasCapabilityGrant>;
}

export function createTenantCasService(issuer: CasCapabilityIssuer, options: { readonly now?: () => number } = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async issue(context: TenantContext, tenantId: string): Promise<CasCapabilityGrant> {
      requireTenantScope(context, tenantId);
      const parsed = CasCapabilityGrantSchema.safeParse(await issuer.issue(context));
      if (!parsed.success) throw new TenantOperationError("unavailable");
      if (parsed.data.tenantId !== context.tenantId) throw new TenantOperationError("forbidden");
      if (parsed.data.expiresAt <= now()) throw new TenantOperationError("unavailable");
      return parsed.data;
    },
  };
}
```

Append to `packages/portal-service/src/index.ts`:

```ts
export { createTenantCasService } from "./tenant/cas.js";
export type { CasCapabilityIssuer } from "./tenant/cas.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @unidocs/portal-service exec vitest run tests/tenant-cas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the whole suite and the workspace typecheck**

```bash
pnpm --filter @unidocs/portal-service test
pnpm typecheck
git diff --check
```

Expected: every portal-service test passes, 44 projects typecheck, and the diff is clean.

- [ ] **Step 6: Commit**

```bash
git add packages/portal-service/src/tenant/cas.ts packages/portal-service/src/index.ts packages/portal-service/tests/tenant-cas.test.ts
git commit -m "feat(tenant): issue short-lived direct-UniCAS capabilities

The Platform hands out a capability rather than proxying node traffic, so
the grant is re-checked on the way out: a grant naming another tenant, or
one that is already expired, is a fault in the issuer and must not reach a
caller who would then hold a credential nobody intended to give them."
```

---

## Out of scope

These are deliberately not in this plan, and no task should start them:

- **D1 schema and repositories.** The document grant role vocabulary is still open in `platform-er-model-v0.md`; freezing tables before it is settled is exactly what that document warns against.
- **oRPC handler wiring in `@unidocs/cloudflare-portal`.** It follows the `createDocumentTypesHttp` shape and needs the repositories first.
- **Tenant sessions and the `__Host-unidocs_tenant` cookie.** No tenant login exists yet; `TenantContext` is the seam it will fill.
- **A real `DocumentLocationValidator`.** No SValue schema validator exists in the repository yet. The port is declared so the adapter must supply one.
- **Agent submissions (§9).** Until they exist, no version can be created, so versions, threads and comments have nothing real to operate on. That is expected: this plan fixes the business rules so the data plane is ready when submissions land.


---

## Follow-ups left open when this plan landed

Recorded here because the execution workspace that held them is deleted once the
branch is done. None blocks the business core; all four were adjudicated during
the final review and deliberately not fixed.

- **`threads.ts` — the location-payload canonicalization guard is unpinned.** Removing
  the `guardCanonicalization` wrap around the payload measurement leaves the whole
  suite green, because both lone-surrogate tests pass `location: null`. The code is
  correct; one test closes it. This is the same gap class the final review raised
  against five other operations, reintroduced by the fix for a different one.
- **`guardCanonicalization` converts any `TypeError`.** A genuine programming error
  inside the guarded closure reaches the tenant as `invalid_request` rather than a
  fault. The closures are single expressions over Zod-parsed plain data, so the blast
  radius is small; the clean fix is a dedicated error class thrown by
  `canonicalJson` in `src/identity.ts`, which belongs with that module.
- **`versions.ts` — `await snapshot.body.cancel()` is itself unguarded.** A rejecting
  cancel (a locked stream rejects with a `TypeError`) makes `getSnapshot` reject with
  that instead of `content_unavailable`, turning a declared 409 into an uncoded 500 on
  the path the cancel was added to clean up. `.catch(() => {})` makes it best-effort.
- **Unguarded canonicalization outside `tenant/`.** `src/admin/document-types.ts`,
  `src/bundles/manifest.ts` and `src/operators/discovery.ts` all canonicalize without
  the guard. Pre-existing, and out of this plan's scope.

## What the storage adapter must know

Accumulated while writing the business core; none of it is expressible in the
repository interfaces themselves.

- **Authorization lives in the repository.** Every service passes `TenantContext`
  through and compares only the path tenant against the credential tenant. Whether a
  principal may read or write a given document is the repository's decision, the way
  `D1DocumentTypeRepository.authorize()` already works on the administrator side.
  Settle the `DOCUMENT_GRANT` role vocabulary before the tables freeze.
- **Scope every idempotency key by its path.** The fingerprint identifies the request
  body, not the target: `createDocument`'s omits `tenantId`, `createThread`'s omits
  `documentId`. The commands carry those ids, so the key must be scoped by
  `(tenantId, principal, operation, documentId[, threadId])` — the fingerprint only
  detects the same key reused with a different body.
- **`document_type_disabled` and `createDocument`'s declared 413 are yours.** Neither
  is knowable in the business core: the enabled flag is storage state on the
  administrator registration, and the 413 is reserved for a per-tenant document quota.
- **Coerce query strings.** `PaginationQuerySchema` types `limit` as a number while
  HTTP delivers a string; without coercion every paged GET returns 400. Bodies are
  validated exactly (unknown fields rejected); query strings are lenient (unknown keys
  stripped).
- **Two error classes reach your mapper.** `TenantAccessError` (`unauthorized`,
  `forbidden`) comes from the authentication boundary and `TenantOperationError` from
  the services; both can produce `forbidden` with the same message. Anything else
  reaching the mapper is a fault, not a tenant error.
- **`CasCapabilityGrant.expiresAt` is a Unix timestamp in seconds.** The service's
  default clock assumes it, and no test would catch an issuer that returned
  milliseconds.
- **Repository-minted ids must be printable ASCII no longer than 128 bytes.** The
  services run `requireIdentifier` on `documentId` and `threadId` when reading, so an
  id containing padding or braces would round-trip on write and fail on read.
