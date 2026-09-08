import { AdminDirectoryError } from "./admin-directory.js";

export interface DocTypeDescriptor {
  readonly docType: string;
  readonly displayName: string;
  readonly description: string;
  readonly serviceId: string;
  readonly storageIdentity: string;
  readonly audience: string;
  readonly protocol: "unidocs-doctype/1";
  readonly editorProtocol: "0.1" | null;
  readonly formats: readonly string[];
  readonly capabilities: { readonly preview: boolean; readonly edit: boolean };
}

export interface AdminTypeRegistration {
  readonly docType: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly descriptor: DocTypeDescriptor;
  readonly checkedAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface AdminUrlValidation {
  readonly validationId: string;
  readonly requestFingerprint: string;
  readonly actorId: string;
  readonly baseUrl: string;
  readonly expectedDocType: string | null;
  readonly expectedRevision: number | null;
  readonly descriptor: DocTypeDescriptor;
  readonly checkedAt: string;
  readonly expiresAt: number;
  readonly policyKey: string;
}

export function normalizeDocTypeBaseUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) throw new AdminDirectoryError("invalid_base_url", 400);
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new AdminDirectoryError("invalid_base_url", 400); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port
    || /[%\\]/.test(input) || url.hostname.endsWith(".") || url.hostname === "localhost"
    || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new AdminDirectoryError("invalid_base_url", 400);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function parseDocTypeDescriptor(value: unknown): DocTypeDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminDirectoryError("invalid_descriptor", 422);
  const input = value as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const candidate = input[key];
    if (typeof candidate !== "string" || !candidate.trim() || candidate.length > max || /[\u0000-\u001f\u007f]/.test(candidate)) throw new AdminDirectoryError("invalid_descriptor", 422);
    return candidate;
  };
  const docType = text("docType", 64);
  if (!/^[a-z][a-z0-9-]*$/.test(docType) || input.protocol !== "unidocs-doctype/1" || input.editorProtocol !== "0.1" && input.editorProtocol !== null) throw new AdminDirectoryError("incompatible_descriptor", 422);
  if (!Array.isArray(input.formats) || input.formats.length === 0 || input.formats.length > 32
    || !input.formats.every(format => typeof format === "string" && /^\.[a-z0-9]{1,16}$/.test(format))) throw new AdminDirectoryError("invalid_descriptor", 422);
  const capabilities = input.capabilities as Record<string, unknown> | undefined;
  if (!capabilities || typeof capabilities.preview !== "boolean" || typeof capabilities.edit !== "boolean") throw new AdminDirectoryError("invalid_descriptor", 422);
  if (input.editorProtocol === null && (capabilities.preview || capabilities.edit)) throw new AdminDirectoryError("incompatible_descriptor", 422);
  return {
    docType, displayName: text("displayName", 120), description: text("description", 1000),
    serviceId: text("serviceId", 128), storageIdentity: text("storageIdentity", 128), audience: text("audience", 512),
    protocol: "unidocs-doctype/1", editorProtocol: input.editorProtocol, formats: [...new Set(input.formats as string[])],
    capabilities: { preview: capabilities.preview, edit: capabilities.edit },
  };
}

export function adminTypeEtag(record: AdminTypeRegistration): string { return `"type-${record.docType}-${record.revision}"`; }

export function matchDocTypeIdentity(previous: DocTypeDescriptor, next: DocTypeDescriptor): void {
  if (previous.docType !== next.docType) throw new AdminDirectoryError("doctype_mismatch", 422);
  if (previous.serviceId !== next.serviceId || previous.storageIdentity !== next.storageIdentity || previous.audience !== next.audience) throw new AdminDirectoryError("service_identity_mismatch", 422);
}