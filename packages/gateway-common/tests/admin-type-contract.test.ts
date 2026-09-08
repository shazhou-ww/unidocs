import { expect, it } from "vitest";
import { normalizeDocTypeBaseUrl, parseDocTypeDescriptor, matchDocTypeIdentity } from "../src/admin-type-contract.js";

const descriptor = { docType: "markdown", displayName: "Markdown", description: "Text documents", serviceId: "md", storageIdentity: "md-storage", audience: "md-audience", protocol: "unidocs-doctype/1", editorProtocol: "0.1", formats: [".md"], capabilities: { preview: true, edit: false } };

it("normalizes directory bases without losing path prefixes", () => {
  const base = normalizeDocTypeBaseUrl(" https://types.example.com/markdown ");
  expect(base).toBe("https://types.example.com/markdown/");
  expect(new URL("./api/", base).href).toBe("https://types.example.com/markdown/api/");
  expect(new URL("./editor/", base).href).toBe("https://types.example.com/markdown/editor/");
});

it("rejects unsafe or ambiguous base URLs", () => {
  for (const value of ["http://types.example.com", "https://a:b@types.example.com", "https://types.example.com/?token=x", "https://types.example.com/#x", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://types.example.com:8443/", "https://types.example.com/%2e%2e/", "https://types.example.com./", "invalid"]) expect(() => normalizeDocTypeBaseUrl(value)).toThrow("invalid_base_url");
});

it("whitelists descriptor fields and refuses unknown protocols or malformed capabilities", () => {
  expect(parseDocTypeDescriptor({ ...descriptor, token: "secret", apiUrl: "https://evil.test/", capabilities: { ...descriptor.capabilities, admin: true } })).toEqual(descriptor);
  for (const value of [{ ...descriptor, protocol: "unknown" }, { ...descriptor, editorProtocol: "2" }, { ...descriptor, capabilities: { preview: "true", edit: true } }, { ...descriptor, formats: ["../../secret"] }, { ...descriptor, serviceId: "" }]) expect(() => parseDocTypeDescriptor(value)).toThrow();
});

it("does not mistake another storage domain for a URL update", () => {
  const original = parseDocTypeDescriptor(descriptor);
  expect(() => matchDocTypeIdentity(original, { ...original, storageIdentity: "another" })).toThrow("service_identity_mismatch");
  expect(() => matchDocTypeIdentity(original, { ...original, docType: "psd" })).toThrow("doctype_mismatch");
  expect(() => matchDocTypeIdentity(original, { ...original, displayName: "Updated display" })).not.toThrow();
});

it("allows an explicitly unavailable editor but rejects contradictory capabilities", () => {
  expect(parseDocTypeDescriptor({ ...descriptor, editorProtocol: null, capabilities: { preview: false, edit: false } }).editorProtocol).toBeNull();
  expect(() => parseDocTypeDescriptor({ ...descriptor, editorProtocol: null })).toThrow("incompatible_descriptor");
});