import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Browser-boundary proof: `src/ui` is the only code delivered to the browser.
 * It must never reference Google secrets, session signing material, tenant
 * JWTs, storage bindings, or the control-plane/server modules — the BFF is
 * the only path browser code talks to.
 */

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/ui");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN_TOKENS = [
  "GOOGLE_OIDC_CLIENT_SECRET",
  "GOOGLE_OIDC_CLIENT_ID",
  "SESSION_ENCRYPTION_KEYS",
  "CAS_CONTROL_DB",
  "D1Database",
  "DurableObject",
  "R2Bucket",
  "cloudflare-cas",
  "Bearer",
  "Authorization",
];

const FORBIDDEN_IMPORTS = [
  "@unidocs/cas-control-plane",
  "../server/",
];

describe("cas-admin-webui browser boundary", () => {
  test("browser code never references secrets, storage bindings, or tenant credentials", () => {
    const files = listFiles(UI_DIR);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        expect(source, `${file} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  test("browser code imports neither the control-plane library nor server modules", () => {
    const files = listFiles(UI_DIR);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const target of FORBIDDEN_IMPORTS) {
        expect(source, `${file} must not import ${target}`).not.toContain(`from "${target}`);
        expect(source, `${file} must not import ${target}`).not.toContain(`from '${target}`);
      }
    }
  });

  test("protocol types are only imported as type-only in browser code", () => {
    // Runtime imports of @unidocs/protocol-cas-admin would drag the whole
    // package into the browser bundle; only erased type imports are allowed.
    const files = listFiles(UI_DIR);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        const match = /import\s+\{([^}]+)\}\s+from\s+["']@unidocs\/protocol-cas-admin["']/.exec(line);
        if (match) {
          const specifiers = match[1]!.split(",").map((part) => part.trim()).filter(Boolean);
          for (const specifier of specifiers) {
            const isTypeOnly = specifier.startsWith("type ");
            expect(isTypeOnly, `${file} must use type-only imports for protocol-cas-admin: ${specifier}`).toBe(true);
          }
        }
      }
    }
  });
});
