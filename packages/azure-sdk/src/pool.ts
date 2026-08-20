import { Pool } from "pg";
import { BlobServiceClient } from "@azure/storage-blob";

/**
 * Connection configuration for the local/Azure storage stack.
 *
 * `databaseUrl` is a standard `postgres://` connection string; `blobConnectionString`
 * is the Azure Storage (or Azurite) connection string consumed by
 * `BlobServiceClient.fromConnectionString`.
 */
export interface AzureConfig {
  databaseUrl: string;
  blobConnectionString: string;
}

/**
 * Creates a `pg` connection pool for the Postgres-backed ports. Callers own the
 * pool's lifecycle (including calling `.end()`).
 */
export function createPool(cfg: AzureConfig): Pool {
  return new Pool({ connectionString: cfg.databaseUrl });
}

/**
 * Creates a Blob Storage client for the CAS / snapshot ports. Works against both
 * a real Azure Storage account and a local Azurite instance.
 */
export function createBlobService(cfg: AzureConfig): BlobServiceClient {
  return BlobServiceClient.fromConnectionString(cfg.blobConnectionString);
}
