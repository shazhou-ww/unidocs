import canonicalize from "canonicalize";

function assertJson(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new TypeError("Canonical JSON requires well-formed Unicode");
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new TypeError("Canonical JSON requires a JSON value");
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot contain cycles");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Canonical JSON requires plain objects");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const child of value) assertJson(child, ancestors);
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertJson(key, ancestors);
      assertJson(child, ancestors);
    }
  }
  ancestors.delete(value);
}

export function canonicalJson(value: unknown): string {
  assertJson(value, new Set());
  const result = canonicalize(value);
  if (result === undefined) throw new TypeError("Canonical JSON requires a JSON value");
  return result;
}

async function digest(value: unknown): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))));
}

export async function schemaHash(schema: unknown): Promise<string> {
  const bytes = await digest(schema);
  return `sha256:${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function contractHash(contract: {
  readonly documentType: string;
  readonly formatVersion: number;
  readonly snapshot: { readonly schema: unknown };
  readonly location: { readonly schema: unknown };
}): Promise<string> {
  return schemaHash({
    documentType: contract.documentType,
    formatVersion: contract.formatVersion,
    snapshot: { schema: contract.snapshot.schema },
    location: { schema: contract.location.schema },
  });
}

export async function resourceEtag(resource: Readonly<Record<string, unknown>>): Promise<string> {
  const representation = Object.fromEntries(Object.entries(resource).filter(([key]) => key !== "etag"));
  const bytes = await digest(representation);
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `"sha256-${encoded}"`;
}