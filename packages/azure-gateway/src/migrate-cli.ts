import { fileURLToPath } from "node:url";
import {
  attachPoolErrorLogger,
  createPool,
  requireEnv,
  runMigrations,
} from "@unidocs/azure-sdk";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

async function main(): Promise<void> {
  const pool = createPool({
    databaseUrl: requireEnv("DATABASE_URL"),
    blobConnectionString: "",
  });
  attachPoolErrorLogger(pool, "azure-gateway-migrate");
  try {
    await runMigrations(pool, MIGRATIONS_DIR);
    console.log("gateway migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("azure-gateway migrate-cli failed:", err);
  process.exit(1);
});
