import type { ContractRouterClient } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AppendPingRequestSchema,
  CreateThreadRequestSchema,
  DocumentAuditEventSchema,
  DocumentContractRecordSchema,
  DocumentLocationSchema,
  MessageContentSchema,
  MoveCurrentVersionRequestSchema,
  PublicDocumentTypeSchema,
  PublicTypeCardIconPngSchema,
  PublicTypeCardSchema,
  TenantApiV1BasePath,
  VersionRecordSchema,
  documentLocationContentType,
  documentSnapshotContentType,
  tenantApiContract,
} from "../src/index.js";
import type { DocumentRecord, VersionRecord } from "../src/index.js";
import { ReferenceLocales, renderTenantApiReferenceHtml } from "../scripts/html.js";
import { zhTenantApiStrings, zhTenantApiTranslation } from "../scripts/locales/zh.js";
import {
  collectProseStrings,
  collectTagNames,
  localizeDocument,
  missingTranslations,
} from "../scripts/localize.js";
import { generateTenantOpenApiDocument } from "../scripts/openapi.js";

const methodNames = ["get", "post", "put", "patch", "delete"] as const;

interface TestOperation {
  readonly operationId?: string;
  readonly parameters?: unknown[];
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly responses?: Record<string, { content?: Record<string, unknown> }>;
}

type TestDocument = Awaited<ReturnType<typeof generateTenantOpenApiDocument>>;

function operationEntries(document: TestDocument) {
  return Object.entries(document.paths ?? {}).flatMap(([path, item]) => {
    if (item === undefined) return [];
    return methodNames.flatMap((method) => {
      const operation = item[method];
      return operation === undefined
        ? []
        : [{ path, method, operation: operation as TestOperation }];
    });
  });
}

function parameterNames(operation: TestOperation) {
  return (operation.parameters ?? []).map((parameter) =>
    "$ref" in (parameter as object)
      ? String((parameter as { $ref: string }).$ref)
      : String((parameter as { name: string }).name),
  );
}

function errorStatuses(operation: TestOperation) {
  return Object.keys(operation.responses ?? {})
    .filter((status) => Number(status) >= 400)
    .sort();
}

const svalueSchema = { $schema: "https://schemas.unidocs.dev/svalue/v1" } as const;
const textContent = { text: "Please shorten this", richContent: null, attachments: [] } as const;

const markdownLocation = {
  documentContractIdx: 0,
  locationType: "unidocs.markdown.text-range/v1",
  payload: { start: 120, end: 180 },
} as const;

describe("tenant resource schemas", () => {
  it("keeps the snapshot out of version metadata and requires provenance", () => {
    const version = {
      versionIdx: 7,
      parentVersionIdx: 6,
      documentContractIdx: 0,
      authorAgentId: "op_markdown",
      submissionId: "sub_91",
      addressedPings: [{ threadId: "th_2", pingIdx: 3, baseVersionIdx: 5 }],
      createdAt: "2026-09-11T03:12:00Z",
    };

    const parsed = VersionRecordSchema.parse(version);
    expect(parsed).not.toHaveProperty("snapshot");
    expectTypeOf<VersionRecord>().not.toHaveProperty("snapshot");

    const { addressedPings: _omitted, ...withoutProvenance } = version;
    expect(VersionRecordSchema.safeParse(withoutProvenance).success).toBe(false);
  });

  it("accepts an empty provenance set only as an explicit empty array", () => {
    const firstVersion = {
      versionIdx: 0,
      parentVersionIdx: null,
      documentContractIdx: 0,
      authorAgentId: "op_markdown",
      submissionId: "sub_1",
      addressedPings: [],
      createdAt: "2026-09-11T03:12:00Z",
    };

    expect(VersionRecordSchema.safeParse(firstVersion).success).toBe(true);
    expect(VersionRecordSchema.safeParse({ ...firstVersion, addressedPings: null }).success)
      .toBe(false);
  });

  it("requires the current-version equality lock to be stated, including null", () => {
    const move = {
      observedCurrentVersionIdx: null,
      targetVersionIdx: 3,
      reason: "Restore the reviewed draft",
    };

    expect(MoveCurrentVersionRequestSchema.safeParse(move).success).toBe(true);
    const { observedCurrentVersionIdx: _omitted, ...withoutLock } = move;
    expect(MoveCurrentVersionRequestSchema.safeParse(withoutLock).success).toBe(false);
    expect(MoveCurrentVersionRequestSchema.safeParse({ ...move, reason: "" }).success).toBe(false);
  });

  it("requires a message body that attachments cannot replace", () => {
    expect(MessageContentSchema.safeParse(textContent).success).toBe(true);
    expect(MessageContentSchema.safeParse({
      text: null,
      richContent: { blobHash: "b3:9f2c", size: 12, contentType: "text/html" },
      attachments: [],
    }).success).toBe(true);
    expect(MessageContentSchema.safeParse({
      text: null,
      richContent: null,
      attachments: [{ blobHash: "b3:9f2c", size: 12, contentType: "image/webp" }],
    }).success).toBe(false);
  });

  it("anchors thread and ping creation to an existing version", () => {
    const request = { baseVersionIdx: 5, content: textContent, location: markdownLocation };

    expect(CreateThreadRequestSchema.safeParse(request).success).toBe(true);
    expect(AppendPingRequestSchema.safeParse({ ...request, location: null }).success).toBe(true);
    expect(AppendPingRequestSchema.safeParse({ ...request, baseVersionIdx: -1 }).success)
      .toBe(false);
    const { baseVersionIdx: _omitted, ...withoutBase } = request;
    expect(CreateThreadRequestSchema.safeParse(withoutBase).success).toBe(false);
  });

  it("keeps a location's contract revision as a zero-based index", () => {
    expect(DocumentLocationSchema.safeParse(markdownLocation).success).toBe(true);
    expect(DocumentLocationSchema.safeParse({ ...markdownLocation, documentContractIdx: 1.5 })
      .success).toBe(false);
    expect(DocumentLocationSchema.safeParse({ ...markdownLocation, documentContractIdx: -1 })
      .success).toBe(false);
  });

  it("derives snapshot and location media types from the same documentType", () => {
    const record = {
      documentType: "markdown",
      documentContractIdx: 0,
      formatVersion: 1,
      snapshot: {
        contentType: documentSnapshotContentType("markdown"),
        schema: svalueSchema,
        schemaHash: "sha256:snapshot",
      },
      location: {
        contentType: documentLocationContentType("markdown"),
        schema: svalueSchema,
        schemaHash: "sha256:location",
      },
      contractHash: "sha256:contract",
      createdAt: "2026-09-11T03:12:00Z",
    };

    expect(DocumentContractRecordSchema.safeParse(record).success).toBe(true);
    expect(DocumentContractRecordSchema.safeParse({
      ...record,
      location: { ...record.location, contentType: documentLocationContentType("psd") },
    }).success).toBe(false);
  });

  it("requires the English Type Card locale in the public projection", () => {
    const base = {
      icon: { kind: "svg", url: "https://bundles.example/type-card-bundles/tb_1/icon.svg" },
      sampleThumbnailUrl: "https://bundles.example/type-card-bundles/tb_1/sample.webp",
    } as const;

    expect(PublicTypeCardSchema.safeParse({
      ...base,
      locales: { en: { name: "Markdown", description: "Text", sampleThumbnailAlt: "Sample" } },
    }).success).toBe(true);
    expect(PublicTypeCardSchema.safeParse({
      ...base,
      locales: { fr: { name: "Markdown", description: "Texte", sampleThumbnailAlt: "Exemple" } },
    }).success).toBe(false);
  });

  it("requires every predefined PNG icon size", () => {
    const url = (size: number) => `https://bundles.example/type-card-bundles/tb_1/${size}.png`;
    const complete = {
      kind: "png",
      imageUrls: { 16: url(16), 32: url(32), 64: url(64), 128: url(128), 256: url(256) },
    };

    expect(PublicTypeCardIconPngSchema.safeParse(complete).success).toBe(true);
    const { 256: _omitted, ...incomplete } = complete.imageUrls;
    expect(PublicTypeCardIconPngSchema.safeParse({ kind: "png", imageUrls: incomplete }).success)
      .toBe(false);
  });

  it("never publishes a document type without a usable contract revision", () => {
    const base = {
      documentType: "markdown",
      typeCardBundleId: "tb_1",
      typeCard: {
        locales: { en: { name: "Markdown", description: "Text", sampleThumbnailAlt: "Sample" } },
        icon: { kind: "svg", url: "https://bundles.example/type-card-bundles/tb_1/icon.svg" },
        sampleThumbnailUrl: "https://bundles.example/type-card-bundles/tb_1/sample.webp",
      },
      viewBundleId: "vb_1",
    };

    expect(PublicDocumentTypeSchema.safeParse({
      ...base,
      availableDocumentContractIdxs: [0, 2],
    }).success).toBe(true);
    expect(PublicDocumentTypeSchema.safeParse({
      ...base,
      availableDocumentContractIdxs: [],
    }).success).toBe(false);
  });

  it("records both sides of a current-pointer move in one audit event", () => {
    expect(DocumentAuditEventSchema.safeParse({
      auditEventId: "ae_1",
      actorId: "u_42",
      action: "current_version.moved",
      beforeVersionIdx: 7,
      afterVersionIdx: 3,
      reason: "Restore the reviewed draft",
      requestId: "req_9",
      occurredAt: "2026-09-11T03:12:00Z",
    }).success).toBe(true);
    expect(DocumentAuditEventSchema.safeParse({
      auditEventId: "ae_0",
      actorId: "u_42",
      action: "thread.resolved",
      beforeVersionIdx: null,
      afterVersionIdx: null,
      reason: null,
      requestId: "req_1",
      occurredAt: "2026-09-11T03:12:00Z",
    }).success).toBe(false);
  });
});

describe("tenant API contract", () => {
  it("exposes the tenant-scoped v1 base path on every operation", async () => {
    const document = await generateTenantOpenApiDocument();
    const paths = Object.keys(document.paths ?? {});

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.startsWith(TenantApiV1BasePath))).toBe(true);
    expect(operationEntries(document).every(({ operation }) =>
      parameterNames(operation).includes("tenantId")
    )).toBe(true);
  });

  it("requires an idempotency key exactly where a retry would duplicate a record", async () => {
    const document = await generateTenantOpenApiDocument();
    const idempotent = operationEntries(document)
      .filter(({ operation }) => parameterNames(operation).includes("idempotency-key"))
      .map(({ operation }) => operation.operationId)
      .sort();

    expect(idempotent).toEqual(["appendPing", "createDocument", "createThread"]);
  });

  it("models Bearer-or-cookie reads and CSRF-protected cookie mutations", async () => {
    const document = await generateTenantOpenApiDocument();

    expect(document.security).toEqual([{ tenantBearer: [] }, { tenantSession: [] }]);

    for (const { method, operation } of operationEntries(document)) {
      if (method === "get") {
        // Reads inherit the document-level Bearer OR cookie requirement.
        expect(operation.security).toBeUndefined();
      } else {
        expect(operation.security).toEqual([
          { tenantBearer: [] },
          { tenantSession: [], tenantCsrf: [] },
        ]);
      }
    }
  });

  it("attaches only the errors each operation can actually produce", async () => {
    const document = await generateTenantOpenApiDocument();
    const byOperationId = new Map(
      operationEntries(document).map(({ operation }) => [operation.operationId, operation]),
    );

    const listDocuments = byOperationId.get("listDocuments");
    expect(listDocuments).toBeDefined();
    expect(errorStatuses(listDocuments!)).not.toContain("409");
    expect(errorStatuses(listDocuments!)).not.toContain("422");

    const createDocument = byOperationId.get("createDocument");
    expect(errorStatuses(createDocument!)).toContain("409");
    expect(errorStatuses(createDocument!)).toContain("413");

    const appendPing = byOperationId.get("appendPing");
    expect(errorStatuses(appendPing!)).toContain("422");

    const moveCurrentVersion = byOperationId.get("moveCurrentVersion");
    expect(errorStatuses(moveCurrentVersion!)).toContain("409");
    expect(errorStatuses(moveCurrentVersion!)).not.toContain("422");
  });

  it("returns the snapshot as binary rather than JSON", async () => {
    const document = await generateTenantOpenApiDocument();
    const snapshot = operationEntries(document)
      .find(({ operation }) => operation.operationId === "getVersionSnapshot");

    expect(snapshot).toBeDefined();
    const successContent = snapshot!.operation.responses?.["200"]?.content ?? {};
    expect(Object.keys(successContent)).not.toContain("application/json");

    const version = operationEntries(document)
      .find(({ operation }) => operation.operationId === "getVersion");
    expect(Object.keys(version!.operation.responses?.["200"]?.content ?? {}))
      .toContain("application/json");
  });

  it("offers no operation that resolves, reopens, edits, or deletes a message", async () => {
    const document = await generateTenantOpenApiDocument();
    const operationIds = operationEntries(document)
      .map(({ operation }) => operation.operationId ?? "");

    expect(operationIds.some((id) => /resolve|reopen|deletePing|updatePing|withdraw/i.test(id)))
      .toBe(false);
    expect(operationEntries(document).some(({ method }) => method === "delete" || method === "put"))
      .toBe(false);
  });

  it("derives a complete client type from the contract", () => {
    type TenantClient = ContractRouterClient<typeof tenantApiContract>;

    expectTypeOf<Awaited<ReturnType<TenantClient["documents"]["get"]>>>()
      .toEqualTypeOf<DocumentRecord>();
    expectTypeOf<Awaited<ReturnType<TenantClient["versions"]["get"]>>>()
      .toEqualTypeOf<VersionRecord>();
  });

  it("renders one self-contained Scalar reference holding every translation", async () => {
    const en = await generateTenantOpenApiDocument();
    const html = renderTenantApiReferenceHtml({
      en,
      zh: localizeDocument(en, zhTenantApiTranslation),
    });

    expect(html).toContain("<title>UniDocs Tenant API</title>");
    expect(html).toContain("preferredSecurityScheme: 'tenantSession'");
    expect(html).toContain("\"operationId\":\"appendPing\"");
    for (const locale of ReferenceLocales) {
      expect(html).toContain(locale.label);
    }
    expect(html).toContain("向 thread 追加一条 ping");
    expect(html).toContain("Append a ping to a thread");
  });

  it("escapes markup that would otherwise break out of the inline script", async () => {
    const en = await generateTenantOpenApiDocument();
    const hostile = {
      ...en,
      info: { ...en.info, title: "</script><script>alert(1)</script>" },
    };

    const html = renderTenantApiReferenceHtml({ en: hostile, zh: hostile });

    expect(html).not.toContain("</script><script>alert");
    expect(html).toContain("\\u003c/script>");
  });
});

describe("Simplified Chinese reference", () => {
  it("translates every prose string in the document", async () => {
    const en = await generateTenantOpenApiDocument();

    expect(missingTranslations(en, zhTenantApiStrings)).toEqual([]);
  });

  it("carries no translation the contract no longer uses", async () => {
    const en = await generateTenantOpenApiDocument();
    const used = new Set(collectProseStrings(en));

    expect(Object.keys(zhTenantApiStrings).filter((text) => !used.has(text))).toEqual([]);
  });

  it("translates prose without touching identifiers or structure", async () => {
    const en = await generateTenantOpenApiDocument();
    const zh = localizeDocument(en, zhTenantApiTranslation);

    const strip = (document: unknown) =>
      JSON.parse(JSON.stringify(document, (key, value) =>
        (key === "description" || key === "summary" || key === "tags" || key === "name")
            && (typeof value === "string" || Array.isArray(value))
          ? undefined
          : value));

    expect(strip(zh)).toEqual(strip(en));
    expect(collectProseStrings(zh).some((text) => /[\u4e00-\u9fff]/.test(text))).toBe(true);
  });

  it("refuses to emit a half-translated reference", async () => {
    const en = await generateTenantOpenApiDocument();

    expect(() => localizeDocument(en, {
      prose: { "Create a document": "创建文档" },
      tagNames: zhTenantApiTranslation.tagNames,
    })).toThrow(/untranslated string/);
  });

  it("renames navigation headings and the operations filed under them together", async () => {
    const en = await generateTenantOpenApiDocument();
    const zh = localizeDocument(en, zhTenantApiTranslation);

    const declared = new Set((zh.tags ?? []).map((tag) => tag.name));
    expect(declared.has("文档类型")).toBe(true);
    expect(collectTagNames(zh).every((tag) => declared.has(tag))).toBe(true);
    expect(collectTagNames(zh)).not.toContain("Document types");
  });

  it("keeps status-derived response descriptions out of the translation surface", async () => {
    const en = await generateTenantOpenApiDocument();

    expect(collectProseStrings(en).filter((text) => /^(OK|\d{3})$/.test(text))).toEqual([]);
  });
});
