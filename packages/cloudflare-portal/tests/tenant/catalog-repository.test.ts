import { describe, expect, it } from "vitest";
import { DocumentContractRecordSchema, PublicDocumentTypeSchema } from "@unidocs/protocol-tenant-portal";
import { D1TenantCatalogRepository } from "../../src/tenant/catalog-repository.js";
import { encodeCursor } from "../../src/tenant/cursor.js";
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

/** A publishable registration for an arbitrary document type, used by the paging tests below. */
function registrationFor(documentType: string) {
  return registration({
    documentType,
    builtinOperator: { operatorId: "op-1", descriptor: { supportedDocumentContracts: { [documentType]: [1, 2] } } },
  });
}

describe("D1TenantCatalogRepository.listDocumentTypes", () => {
  it("projects a public document type from the registration alone", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
    );
    const page = await repository.listDocumentTypes(context, {});
    expect(page.items).toHaveLength(1);
    expect(PublicDocumentTypeSchema.safeParse(page.items[0]).success).toBe(true);
  });

  it("intersects the View's and the Operator's supported revisions", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
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
    );
    expect((await repository.listDocumentTypes(context, {})).items).toEqual([]);
  });

  it("omits a type that is missing any of the three current selections", async () => {
    for (const missing of ["typeCardBundle", "viewBundle", "builtinOperator"]) {
      const repository = new D1TenantCatalogRepository(
        databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration({ [missing]: null })) }]),
      );
      expect((await repository.listDocumentTypes(context, {})).items, missing).toEqual([]);
    }
  });

  it("skips a structurally malformed registration instead of failing the whole page", async () => {
    // viewBundle.manifest is missing supportedDocumentContractIdxs entirely, so
    // projecting it throws a raw TypeError deep inside field access - before
    // PublicDocumentTypeSchema.parse() ever runs. That must not take down the
    // rest of the page: the well-formed "markdown" row must still come back.
    const broken = registration({ documentType: "broken", viewBundle: { viewBundleId: "vb-broken", manifest: {} } });
    const rows = [
      { document_type: "broken", registration_json: JSON.stringify(broken) },
      { document_type: "markdown", registration_json: JSON.stringify(registration()) },
    ];
    const repository = new D1TenantCatalogRepository(databaseDouble(rows));
    const page = await repository.listDocumentTypes(context, {});
    expect(page.items.map(item => item.documentType)).toEqual(["markdown"]);
  });

  it("resolves type card asset paths against the bundle url", async () => {
    const repository = new D1TenantCatalogRepository(
      databaseDouble([{ document_type: "markdown", registration_json: JSON.stringify(registration()) }]),
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
    const repository = new D1TenantCatalogRepository(databaseDouble([]));
    await expect(repository.listDocumentTypes(context, { cursor: "not-a-valid-cursor!!" }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  it("returns a non-null nextCursor and drops the probe row once more rows exist than the limit", async () => {
    // ORDER BY document_type DESC, so "gamma" sorts before "beta" before "alpha".
    const rows = ["gamma", "beta", "alpha"].map(documentType => ({
      document_type: documentType,
      registration_json: JSON.stringify(registrationFor(documentType)),
    }));
    const repository = new D1TenantCatalogRepository(databaseDouble(rows));
    const page = await repository.listDocumentTypes(context, { limit: 2 });
    // "alpha" is the limit+1 probe row: it proves there is a next page but is
    // itself dropped from the returned items.
    expect(page.items.map(item => item.documentType)).toEqual(["gamma", "beta"]);
    expect(page.nextCursor).toBe(encodeCursor({ at: 0, id: "beta" }));
  });

  it("returns a null nextCursor when no more rows exist past the limit", async () => {
    const rows = ["gamma", "beta"].map(documentType => ({
      document_type: documentType,
      registration_json: JSON.stringify(registrationFor(documentType)),
    }));
    const repository = new D1TenantCatalogRepository(databaseDouble(rows));
    const page = await repository.listDocumentTypes(context, { limit: 5 });
    expect(page.items.map(item => item.documentType)).toEqual(["gamma", "beta"]);
    expect(page.nextCursor).toBeNull();
  });

  it("decodes a supplied cursor and binds its id as the query's before parameter", async () => {
    const db = databaseDouble<{ document_type: string; registration_json: string }>([]);
    const repository = new D1TenantCatalogRepository(db);
    await repository.listDocumentTypes(context, { cursor: encodeCursor({ at: 0, id: "markdown" }), limit: 5 });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.sql).toMatch(/FROM portal_document_types/);
    expect(db.statements[0]?.args).toEqual(["markdown", 6]);
  });

  it("binds a null before parameter when no cursor is supplied", async () => {
    const db = databaseDouble<{ document_type: string; registration_json: string }>([]);
    const repository = new D1TenantCatalogRepository(db);
    await repository.listDocumentTypes(context, { limit: 5 });
    expect(db.statements[0]?.args).toEqual([null, 6]);
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
    );
    const record = await repository.getDocumentContract(context, "markdown", 0);
    expect(DocumentContractRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toEqual(contractRow);
  });

  it("returns null when no revision matches", async () => {
    const repository = new D1TenantCatalogRepository(databaseDouble([]));
    expect(await repository.getDocumentContract(context, "markdown", 99)).toBeNull();
  });
});
