import type { ContractRouterClient } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AppendDocumentContractRequestSchema,
  DocumentContentFormatVersion,
  DocumentLocationContentType,
  DocumentSnapshotContentType,
  EtagSchema,
  ExternalEtagSchema,
  SValueSchemaSchema,
  TypeCardBundleManifestV1Schema,
  TypeCardIconPngV1Schema,
  UpdateDocumentTypeRequestSchema,
  adminApiContract,
} from "../src/index.js";
import type { TypeCardBundleRecord } from "../src/index.js";
import { renderAdminApiReferenceHtml } from "../scripts/html.js";
import { generateAdminOpenApiDocument } from "../scripts/openapi.js";

const methodNames = ["get", "post", "put", "patch", "delete"] as const;

interface TestOperation {
  readonly operationId?: string;
  readonly parameters?: unknown[];
  readonly security?: readonly Record<string, readonly string[]>[];
}

function operationEntries(document: Awaited<ReturnType<typeof generateAdminOpenApiDocument>>) {
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

function parameterNames(operation: { parameters?: unknown[] }) {
  return (operation.parameters ?? []).map((parameter) =>
    "$ref" in (parameter as object)
      ? String((parameter as { $ref: string }).$ref)
      : String((parameter as { name: string }).name),
  );
}

describe("administrator schemas", () => {
  it("uses canonical representation hashes as quoted Platform ETags", () => {
    expect(EtagSchema.safeParse(
      "\"sha256-qpj883GyEC_ISq5zghYn7x9MAjOW27ImPGJamTCcRkA\"",
    ).success).toBe(true);
    expect(EtagSchema.safeParse(
      "sha256-qpj883GyEC_ISq5zghYn7x9MAjOW27ImPGJamTCcRkA",
    ).success).toBe(false);
    expect(ExternalEtagSchema.safeParse("\"operator-config-v3\"").success).toBe(true);
  });

  it("pairs snapshot and location schemas in one JSON request", () => {
    expect(AppendDocumentContractRequestSchema.safeParse({
      formatVersion: DocumentContentFormatVersion,
      snapshot: {
        schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      },
      location: {
        schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      },
      reason: "Add structured text locations",
    }).success).toBe(true);
    expect(AppendDocumentContractRequestSchema.safeParse({
      formatVersion: DocumentContentFormatVersion,
      snapshot: {
        schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      },
      reason: "Missing location schema",
    }).success).toBe(false);
    expect(AppendDocumentContractRequestSchema.safeParse({
      formatVersion: 2,
      snapshot: {
        schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      },
      location: {
        schema: { $schema: "https://schemas.unidocs.dev/svalue/v1", type: "object" },
      },
      reason: "Unsupported wire format",
    }).success).toBe(false);
  });

  it("requires the English Type Card locale", () => {
    const base = {
      protocol: "unidocs-type-card/v1",
      documentType: "markdown",
      icon: { kind: "svg", path: "icon.svg" },
      sampleThumbnail: "sample.webp",
    } as const;

    expect(TypeCardBundleManifestV1Schema.safeParse({
      ...base,
      locales: {
        en: { name: "Markdown", description: "Text", sampleThumbnailAlt: "Sample" },
      },
    }).success).toBe(true);
    expect(TypeCardBundleManifestV1Schema.safeParse({
      ...base,
      locales: {
        fr: { name: "Markdown", description: "Texte", sampleThumbnailAlt: "Exemple" },
      },
    }).success).toBe(false);
  });

  it("requires every predefined PNG icon size", () => {
    expect(TypeCardIconPngV1Schema.safeParse({
      kind: "png",
      images: {
        16: "16.png",
        32: "32.png",
        64: "64.png",
        128: "128.png",
        256: "256.png",
      },
    }).success).toBe(true);
    expect(TypeCardIconPngV1Schema.safeParse({
      kind: "png",
      images: { 16: "16.png" },
    }).success).toBe(false);
  });

  it("validates the SValue dialect and non-empty document type updates", () => {
    expect(SValueSchemaSchema.safeParse({
      $schema: "https://schemas.unidocs.dev/svalue/v1",
      type: "object",
      properties: {
        image: { "x-unidocs-sblob": true },
      },
    }).success).toBe(true);
    expect(SValueSchemaSchema.safeParse({ $schema: "https://example.test/schema" }).success)
      .toBe(false);
    expect(SValueSchemaSchema.safeParse({
      $schema: "https://schemas.unidocs.dev/svalue/v1",
      properties: {
        image: {
          "x-unidocs-sblob": true,
          "x-unidocs-blob-max-size": 1024,
        },
      },
    }).success).toBe(false);
    expect(UpdateDocumentTypeRequestSchema.safeParse({ reason: "No setting changed" }).success)
      .toBe(false);
  });

  it("exposes a client type derived from the shared contract", () => {
    type Client = ContractRouterClient<typeof adminApiContract>;
    type GetTypeCardBundleResult = Awaited<
      ReturnType<Client["typeCardBundles"]["get"]>
    >;

    expectTypeOf<GetTypeCardBundleResult>().toEqualTypeOf<TypeCardBundleRecord>();
  });
});

describe("administrator OpenAPI", () => {
  it("describes every Admin v1 operation", async () => {
    const document = await generateAdminOpenApiDocument();
    const operations = operationEntries(document);

    expect(document.openapi).toBe("3.1.1");
    expect(Object.keys(document.paths ?? {})).toHaveLength(15);
    expect(operations).toHaveLength(26);
    expect(new Set(operations.map(({ operation }) => operation.operationId)).size).toBe(26);
    expect(document.info.description).toContain("Administrator control-plane API");
    expect(document.tags?.map((tag) => tag.name)).toEqual([
      "Document types",
      "Document Contracts",
      "Type Card bundles",
      "View bundles",
      "Operators",
      "Members",
      "Audit",
    ]);
    expect(document.tags?.every((tag) => Boolean(tag.description))).toBe(true);
    expect(operations.every(({ operation }) => Boolean(
      (operation as TestOperation & { description?: string }).description,
    ))).toBe(true);
    expect(document.security).toEqual([{ adminBearer: [] }, { adminSession: [] }]);
    expect(document.components?.securitySchemes).toMatchObject({
      adminBearer: { type: "http", scheme: "bearer" },
      adminSession: { type: "apiKey", in: "cookie" },
      adminCsrf: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
    });
    expect(document.info.description).toContain("must not fall back to cookie authentication");
  });

  it("describes ZIP uploads and mutation preconditions", async () => {
    const document = await generateAdminOpenApiDocument();
    const upload = document.paths?.["/admin/api/v1/type-card-bundles"]?.post;
    const patch = document.paths?.["/admin/api/v1/document-types/{documentType}"]?.patch;

    expect(Object.keys(upload?.requestBody && "content" in upload.requestBody
      ? upload.requestBody.content
      : {})).toEqual(["application/zip"]);
    expect(parameterNames(upload ?? {})).toEqual(expect.arrayContaining([
      "name",
      "description",
      "x-csrf-token",
      "idempotency-key",
    ]));
    expect(upload?.parameters?.find((parameter) =>
      !("$ref" in parameter) && parameter.name === "idempotency-key"
    )).toHaveProperty("schema.description");
    expect(upload?.responses).toHaveProperty("201");
    expect(JSON.stringify(upload?.responses?.["409"])).toContain("bundle_already_exists");
    expect(parameterNames(patch ?? {})).toEqual(expect.arrayContaining([
      "documentType",
      "x-csrf-token",
      "idempotency-key",
      "if-match",
    ]));
    expect(patch?.responses).toHaveProperty("412");
    expect(patch?.responses).toHaveProperty("428");
  });

  it("appends paired Document Contracts as JSON without a latest-revision lock", async () => {
    const document = await generateAdminOpenApiDocument();
    const upload = document.paths?.[
      "/admin/api/v1/document-types/{documentType}/document-contracts"
    ]?.post;
    const get = document.paths?.[
      "/admin/api/v1/document-types/{documentType}/document-contracts/{documentContractIdx}"
    ]?.get;

    expect(upload?.operationId).toBe("appendDocumentContract");
    expect(Object.keys(upload?.requestBody && "content" in upload.requestBody
      ? upload.requestBody.content
      : {})).toEqual(["application/json"]);
    expect(parameterNames(upload ?? {})).toEqual(expect.arrayContaining([
      "documentType",
      "idempotency-key",
    ]));
    expect(parameterNames(upload ?? {})).not.toContain("reason");
    const requestBody = JSON.stringify(upload?.requestBody);
    expect(requestBody).toContain("snapshot");
    expect(requestBody).toContain("location");
    expect(requestBody).toContain('"formatVersion"');
    expect(requestBody).not.toContain("contentType");
    expect(requestBody).not.toContain('"snapshot":{"type":"object","readOnly":true');
    expect(requestBody).not.toContain('"location":{"type":"object","readOnly":true');
    const getResponses = JSON.stringify(get?.responses?.["200"]);
    expect(getResponses).toContain(DocumentSnapshotContentType);
    expect(getResponses).toContain(DocumentLocationContentType);
    expect(JSON.stringify(upload)).not.toContain("bundleHash");
    expect(JSON.stringify(upload)).not.toContain("observedLatestDocumentContractIdx");
    const idxParameter = get?.parameters?.find((parameter) =>
      !("$ref" in parameter) && parameter.name === "documentContractIdx"
    );
    expect(idxParameter).toHaveProperty("schema.minimum", 0);
    expect(idxParameter).not.toHaveProperty("schema.exclusiveMinimum");
  });

  it("requires CSRF only for cookie-authenticated mutations", async () => {
    const document = await generateAdminOpenApiDocument();
    const mutations = operationEntries(document).filter(({ method }) => method !== "get");

    expect(mutations).toHaveLength(12);
    for (const { operation } of mutations) {
      expect(operation.security).toEqual([
        { adminBearer: [] },
        { adminSession: [], adminCsrf: [] },
      ]);
      expect(parameterNames(operation)).toEqual(expect.arrayContaining([
        "x-csrf-token",
        "idempotency-key",
      ]));
      expect(operation.parameters?.find((parameter) =>
        !("$ref" in (parameter as object))
        && (parameter as { name?: string }).name === "x-csrf-token"
      )).toHaveProperty("required", false);
    }
  });

  it("keeps stored-resource mutation responses compact", async () => {
    const document = await generateAdminOpenApiDocument();
    const compactResults = [
      [document.paths?.["/admin/api/v1/type-card-bundles"]?.post, "201", "typeCardBundleId"],
      [document.paths?.["/admin/api/v1/type-card-bundles/{typeCardBundleId}"]?.patch, "200", "typeCardBundleId"],
      [document.paths?.["/admin/api/v1/view-bundles"]?.post, "201", "viewBundleId"],
      [document.paths?.["/admin/api/v1/view-bundles/{viewBundleId}"]?.patch, "200", "viewBundleId"],
      [document.paths?.["/admin/api/v1/operator-candidates"]?.post, "201", "operatorCandidateId"],
      [document.paths?.["/admin/api/v1/operator-candidates/{operatorCandidateId}"]?.patch, "200", "operatorCandidateId"],
      [document.paths?.["/admin/api/v1/document-types"]?.post, "201", "documentType"],
      [document.paths?.["/admin/api/v1/document-types/{documentType}"]?.patch, "200", "documentType"],
      [document.paths?.["/admin/api/v1/document-types/{documentType}/document-contracts"]?.post, "201", "documentContractIdx"],
      [document.paths?.["/admin/api/v1/administrators"]?.post, "201", "adminId"],
    ] as const;

    for (const [operation, status, identity] of compactResults) {
      const success = JSON.stringify(operation?.responses?.[status]);
      expect(success).toContain(identity);
      if (identity !== "documentContractIdx") {
        expect(success).toContain("sha256-qpj883GyEC_ISq5zghYn7x9MAjOW27ImPGJamTCcRkA");
        expect(success).toContain("sha256-[A-Za-z0-9_-]{43}");
      }
      expect(success).not.toMatch(/manifest|descriptor|latestDocumentContract|schemaHash/);
    }

    const validation = JSON.stringify(
      document.paths?.["/admin/api/v1/operator-validations"]?.post?.responses?.["200"],
    );
    expect(validation).toContain("validationId");
    expect(validation).toContain("descriptor");
  });

  it("uses summary DTOs for lists and canonical GETs for full resources", async () => {
    const document = await generateAdminOpenApiDocument();
    const lists = [
      document.paths?.["/admin/api/v1/document-types"]?.get,
      document.paths?.["/admin/api/v1/type-card-bundles"]?.get,
      document.paths?.["/admin/api/v1/view-bundles"]?.get,
      document.paths?.["/admin/api/v1/operator-candidates"]?.get,
      document.paths?.["/admin/api/v1/document-types/{documentType}/document-contracts"]?.get,
    ];

    for (const operation of lists) {
      expect(JSON.stringify(operation?.responses?.["200"]))
        .not.toMatch(/"manifest"|"descriptor"|"snapshot"|"location"/);
    }

    const operatorGet = document.paths?.[
      "/admin/api/v1/operator-candidates/{operatorCandidateId}"
    ]?.get;
    const memberGet = document.paths?.["/admin/api/v1/administrators/{adminId}"]?.get;
    expect(operatorGet?.operationId).toBe("getOperatorCandidate");
    expect(JSON.stringify(operatorGet?.responses?.["200"])).toContain("descriptor");
    expect(memberGet?.operationId).toBe("getAdministratorMember");
    expect(JSON.stringify(memberGet?.responses?.["200"])).toContain("email");
  });

  it("documents only operation-applicable errors", async () => {
    const document = await generateAdminOpenApiDocument();
    const collectionGet = document.paths?.["/admin/api/v1/document-types"]?.get;
    const itemGet = document.paths?.["/admin/api/v1/document-types/{documentType}"]?.get;
    const upload = document.paths?.["/admin/api/v1/type-card-bundles"]?.post;
    const patch = document.paths?.[
      "/admin/api/v1/type-card-bundles/{typeCardBundleId}"
    ]?.patch;

    expect(Object.keys(collectionGet?.responses ?? {})).toEqual([
      "200", "400", "401", "403", "500",
    ]);
    expect(Object.keys(itemGet?.responses ?? {})).toEqual([
      "200", "400", "401", "403", "404", "500",
    ]);
    expect(upload?.responses).toHaveProperty("415");
    expect(upload?.responses).toHaveProperty("422");
    expect(upload?.responses).not.toHaveProperty("412");
    expect(patch?.responses).toHaveProperty("412");
    expect(patch?.responses).toHaveProperty("428");
    expect(patch?.responses).not.toHaveProperty("415");
    expect(patch?.responses).not.toHaveProperty("422");
  });

  it("describes administrator member management", async () => {
    const document = await generateAdminOpenApiDocument();
    const collection = document.paths?.["/admin/api/v1/administrators"];
    const member = document.paths?.["/admin/api/v1/administrators/{adminId}"];

    expect(collection?.get?.operationId).toBe("listAdministratorMembers");
    expect(collection?.post?.operationId).toBe("addAdministratorMember");
    expect(collection?.post?.responses).toHaveProperty("201");
    expect(member?.delete?.operationId).toBe("removeAdministratorMember");
    expect(member?.delete?.responses).toHaveProperty("204");
    expect(parameterNames(member?.delete ?? {})).toEqual(expect.arrayContaining([
      "adminId",
      "x-csrf-token",
      "idempotency-key",
      "if-match",
    ]));
  });

  it("describes paginated and filterable administrator audit events", async () => {
    const document = await generateAdminOpenApiDocument();
    const operation = document.paths?.["/admin/api/v1/audit-events"]?.get;

    expect(operation?.operationId).toBe("listAdminAuditEvents");
    expect(parameterNames(operation ?? {})).toEqual(expect.arrayContaining([
      "cursor",
      "limit",
      "actorId",
      "action",
      "resourceType",
      "documentType",
      "occurredFrom",
      "occurredTo",
    ]));
    expect(operation?.security).toBeUndefined();
    expect(operation?.responses).toHaveProperty("200");
  });

  it("renders a standalone HTML reference with the specification embedded", async () => {
    const html = renderAdminApiReferenceHtml(await generateAdminOpenApiDocument());

    expect(html).toContain("Scalar.createApiReference");
    expect(html).toContain("@scalar/api-reference@1.68.0");
    expect(html).toContain("\"openapi\":\"3.1.1\"");
    expect(html).toContain("preferredSecurityScheme: 'adminBearer'");
    expect(html).not.toContain("url: '/admin-v1.openapi.json'");
  });
});
