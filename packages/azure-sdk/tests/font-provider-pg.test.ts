/**
 * Runs the cloud-neutral `WritableFontProvider` contract
 * (`runFontProviderContract`) against `PgFontProvider` on the shared Postgres
 * container — the same container/migration fixture `ports.test.ts` uses
 * (see `tests/containers.ts`).
 *
 * Every `make()` call gets its own `tenantId` (`t${++n}`), scoped under a
 * fixed `stackId`. The tenant provider is scoped to `(stackId, tenantId)`, not
 * to a session, so without a fresh tenant per call the contract's
 * "re-registering collapses to one row" case would run against a table a
 * previous case already populated and pass for the wrong reason.
 */

import { afterAll, beforeAll } from "vitest";
import type { Pool } from "pg";
import { runFontProviderContract } from "@unidocs/doctype-server-common/font-provider-contract";
import { createPool, runMigrations } from "../src/index.js";
import { PgFontProvider } from "../src/font-provider-pg.js";
import { BLOB_CONNECTION_STRING, DATABASE_URL } from "./containers.js";

let pool: Pool;
let n = 0;

beforeAll(async () => {
  pool = createPool({
    databaseUrl: DATABASE_URL,
    blobConnectionString: BLOB_CONNECTION_STRING,
  });
  // Idempotent: whichever test file gets here first applies the schema.
  await runMigrations(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

runFontProviderContract("PgFontProvider", async () =>
  new PgFontProvider(pool, { stackId: "s1", tenantId: `t${++n}` }));
