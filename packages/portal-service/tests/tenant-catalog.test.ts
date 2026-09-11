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
