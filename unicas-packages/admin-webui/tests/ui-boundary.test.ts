import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Browser-boundary proof: `src/ui` is the only code delivered to the browser.
 * It must never reference Google secrets, session signing material, storage
 * bindings, or control-plane/server modules. Only the explicit Playground
 * view may hold a short-lived tenant capability, and it may not persist it.
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
];
const TENANT_CREDENTIAL_TOKENS = ["Bearer", "Authorization"];
const FORBIDDEN_IMPORTS = [
  "../server/",
];

describe("cas-admin-webui browser boundary", () => {
  test("browser code never references secrets or storage bindings", () => {
    const files = listFiles(UI_DIR);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        expect(source, `${file} must not contain ${token}`).not.toContain(token);
      }
      if (!file.endsWith("playground.tsx")) {
        for (const token of TENANT_CREDENTIAL_TOKENS) {
          expect(source, `${file} must not contain ${token}`).not.toContain(token);
        }
      }
    }
  });

  test("the Playground credential exception remains memory-only", () => {
    const source = readFileSync(join(UI_DIR, "views", "playground.tsx"), "utf8");
    expect(source).toContain("Bearer");
    for (const persistenceApi of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
      expect(source, `playground.tsx must not use ${persistenceApi}`).not.toContain(persistenceApi);
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
    // Runtime imports of the admin client or protocol would drag the whole
    // package into the browser bundle; only erased type imports are allowed.
    const files = listFiles(UI_DIR);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        for (const target of ["@unicas/admin-client", "@unicas/admin-protocol"]) {
          const match = new RegExp(`import\\s+\\{([^}]+)\\}\\s+from\\s+["']${target.replace("/", "\\/")}["']`).exec(line);
          if (match) {
            const specifiers = match[1]!.split(",").map((part) => part.trim()).filter(Boolean);
            for (const specifier of specifiers) {
              const isTypeOnly = specifier.startsWith("type ");
              expect(isTypeOnly, `${file} must use type-only imports for ${target}: ${specifier}`).toBe(true);
            }
          }
        }
      }
    }
  });
});
