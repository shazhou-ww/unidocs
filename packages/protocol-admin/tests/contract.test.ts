import type { ContractRouterClient } from "@orpc/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SValueSchemaSchema,
  TypeCardBundleManifestV1Schema,
  TypeCardIconPngV1Schema,
  UpdateDocumentTypeRequestSchema,
  adminApiContract,
} from "../src/index.js";
import type { TypeCardBundleRecord } from "../src/index.js";
import { generateAdminOpenApiDocument } from "../scripts/openapi.js";

const methodNames = ["get", "post", "put", "patch", "delete"] as const;

interface TestOperation {
  readonly operationId?: string;
  readonly parameters?: unknown[];
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
    expect(Object.keys(document.paths ?? {})).toHaveLength(14);
    expect(operations).toHaveLength(23);
    expect(new Set(operations.map(({ operation }) => operation.operationId)).size).toBe(23);
    expect(document.info.description).toContain("Administrator control-plane API");
    expect(document.tags?.map((tag) => tag.name)).toEqual([
      "Document types",
      "Snapshot Contracts",
      "Type Card bundles",
      "View bundles",
      "Operators",
      "Members",
    ]);
    expect(document.tags?.every((tag) => Boolean(tag.description))).toBe(true);
    expect(operations.every(({ operation }) => Boolean(
      (operation as TestOperation & { description?: string }).description,
    ))).toBe(true);
    expect(document.security).toEqual([{ adminSession: [] }]);
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
    expect(parameterNames(patch ?? {})).toEqual(expect.arrayContaining([
      "documentType",
      "x-csrf-token",
      "idempotency-key",
      "if-match",
    ]));
    expect(patch?.responses).toHaveProperty("412");
    expect(patch?.responses).toHaveProperty("428");
  });

  it("requires CSRF and idempotency headers on every mutation", async () => {
    const document = await generateAdminOpenApiDocument();
    const mutations = operationEntries(document).filter(({ method }) => method !== "get");

    expect(mutations).toHaveLength(12);
    for (const { operation } of mutations) {
      expect(parameterNames(operation)).toEqual(expect.arrayContaining([
        "x-csrf-token",
        "idempotency-key",
      ]));
    }
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

});
