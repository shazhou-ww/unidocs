import { describe, expect, it } from "vitest";
import { DocumentContractRecordSchema, PublicDocumentTypeSchema } from "@unidocs/protocol-tenant-portal";
import { D1TenantCatalogRepository } from "../../src/tenant/catalog-repository.js";
import { databaseDouble } from "./d1-double.js";

const context = { tenantId: "t-local", principalId: "user-1", transport: "session" as const };

function registration(over: Record<string, unknown> = {}) {
  return {
    documentType: "markdown",
    internalName: "Markdown",
    enabled: true,
    latestDocumentContract: null,
    typeCardBundle: {
      typeCardBundleId: "tcb-1",
      bundleUrl: "https://bundles.example/type-card-bundles/tcb-1/",
      manifest: {
        protocol: "unidocs-type-card-bundle/v1",
        documentType: "markdown",
        locales: { en: { name: "Markdown", description: "Plain text", sampleThumbnailAlt: "A document" } },
        icon: { kind: "svg", path: "icon.svg" },
        sampleThumbnail: "sample.png",
      },
    },
    viewBundle: {
      viewBundleId: "vb-1",
      manifest: { supportedDocumentContractIdxs: [0, 1] },
    },
    builtinOperator: {
      operatorId: "op-1",
      descriptor: { supportedDocumentContracts: { markdown: [1, 2] } },
    },
    ...over,
  };
}

describe("D1TenantCatalogRepository.listDocumentTypes", () => {
  it("projects a public document type from the registration alone", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
      "https://bundles.example",
    );
    const page = await repository.listDocumentTypes(context, {});
    expect(page.items).toHaveLength(1);
    expect(PublicDocumentTypeSchema.safeParse(page.items[0]).success).toBe(true);
  });

  it("intersects the View's and the Operator's supported revisions", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
      "https://bundles.example",
    );
    const page = await repository.listDocumentTypes(context, {});
    // View supports [0, 1], Operator supports [1, 2] - only 1 is usable.
    expect(page.items[0].availableDocumentContractIdxs).toEqual([1]);
  });

  it("omits a type whose View and Operator share no revision", async () => {
    const noOverlap = registration({
      builtinOperator: { operatorId: "op-1", descriptor: { supportedDocumentContracts: { markdown: [7] } } },
    });
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(noOverlap) }]),
      "https://bundles.example",
    );
    expect((await repository.listDocumentTypes(context, {})).items).toEqual([]);
  });

  it("omits a type that is missing any of the three current selections", async () => {
    for (const missing of ["typeCardBundle", "viewBundle", "builtinOperator"]) {
      const repository = new D1TenantCatalogRepository(
        databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration({ [missing]: null })) }]),
        "https://bundles.example",
      );
      expect((await repository.listDocumentTypes(context, {})).items, missing).toEqual([]);
    }
  });

  it("resolves type card asset paths against the bundle url", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
      "https://bundles.example",
    );
    const [item] = (await repository.listDocumentTypes(context, {})).items;
    expect(item.typeCard.sampleThumbnailUrl).toBe("https://bundles.example/type-card-bundles/tcb-1/sample.png");
  });

  it("resolves every raster size of a png icon against the bundle url", async () => {
    const pngIcon = registration({
      typeCardBundle: {
        typeCardBundleId: "tcb-1",
        bundleUrl: "https://bundles.example/type-card-bundles/tcb-1/",
        manifest: {
          protocol: "unidocs-type-card-bundle/v1",
          documentType: "markdown",
          locales: { en: { name: "Markdown", description: "Plain text", sampleThumbnailAlt: "A document" } },
          icon: { kind: "png", images: { 16: "16.png", 32: "32.png", 64: "64.png", 128: "128.png", 256: "256.png" } },
          sampleThumbnail: "sample.png",
        },
      },
    });
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(pngIcon) }]),
      "https://bundles.example",
    );
    const [item] = (await repository.listDocumentTypes(context, {})).items;
    expect(item.typeCard.icon).toEqual({
      kind: "png",
      imageUrls: {
        16: "https://bundles.example/type-card-bundles/tcb-1/16.png",
        32: "https://bundles.example/type-card-bundles/tcb-1/32.png",
        64: "https://bundles.example/type-card-bundles/tcb-1/64.png",
        128: "https://bundles.example/type-card-bundles/tcb-1/128.png",
        256: "https://bundles.example/type-card-bundles/tcb-1/256.png",
      },
    });
  });

  it("rejects an unparsable cursor rather than silently ignoring it", async () => {
    const repository = new D1TenantCatalogRepository(databaseDouble([]), "https://bundles.example");
    await expect(repository.listDocumentTypes(context, { cursor: "not-a-valid-cursor!!" }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("D1TenantCatalogRepository.getDocumentContract", () => {
  const contractRow = {
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
      schema: { $schema: "https://schemas.unidocs.dev/svalue/v1" },
      schemaHash: "sha256:location",
    },
    contractHash: "sha256:contract",
    createdAt: "2026-09-11T00:00:00.000Z",
  };

  it("returns a validated contract record when the revision exists", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ record_json: JSON.stringify(contractRow) }]),
      "https://bundles.example",
    );
    const record = await repository.getDocumentContract(context, "markdown", 0);
    expect(DocumentContractRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toEqual(contractRow);
  });

  it("returns null when no revision matches", async () => {
    const repository = new D1TenantCatalogRepository(databaseDouble([]), "https://bundles.example");
    expect(await repository.getDocumentContract(context, "markdown", 99)).toBeNull();
  });
});
