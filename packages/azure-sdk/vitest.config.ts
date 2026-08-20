import { defineConfig } from "vitest/config";

/**
 * This package is the one documented exception to the repo's "no vitest config
 * files" rule (CLAUDE.md): its tests need Docker containers, and a container's
 * lifetime spans the whole run rather than a single file. `globalSetup` is the
 * only hook with that scope.
 *
 * `fileParallelism: false` stays as well — the two files share one Postgres
 * database, and one of them truncates tables — but it now lives here rather
 * than as a flag on the `test` script, so running a single file directly
 * (`pnpm --filter @unidocs/azure-sdk exec vitest run tests/ports.test.ts`)
 * gets the same behaviour.
 */
export default defineConfig({
  test: {
    globalSetup: ["./tests/containers.ts"],
    fileParallelism: false,
  },
});
