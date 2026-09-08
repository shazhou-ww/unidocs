import { expect, it } from "vitest";
import { markdownDiscovery, markdownApiRequest } from "../src/discovery.js";

const env = { DOC_SERVICE_ID: "markdown-existing", DOC_STORAGE_IDENTITY: "markdown-store", DOC_CAPABILITY_AUDIENCE: "markdown-audience" };
it("reports configured identity without pretending an embedded editor is available", async () => {
  const response = markdownDiscovery(new Request("https://md.test/.well-known/unidocs-doctype"), env)!;
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ docType: "markdown", serviceId: env.DOC_SERVICE_ID, editorProtocol: null, capabilities: { preview: false, edit: false } });
  expect(markdownDiscovery(new Request("https://md.test/editor/"), env)!.status).toBe(501);
});
it("fails closed on missing identity and keeps health explicitly configuration-only", async () => {
  expect(markdownDiscovery(new Request("https://md.test/.well-known/unidocs-doctype"), {})!.status).toBe(503);
  expect(await markdownDiscovery(new Request("https://md.test/health"), env)!.json()).toEqual({ status: "ok", checks: "configuration-only" });
  expect(await markdownDiscovery(new Request("https://md.test/health", { method: "HEAD" }), env)!.text()).toBe("");
  expect(markdownDiscovery(new Request("https://md.test/health", { method: "POST" }), env)!.status).toBe(405);
  expect(markdownDiscovery(new Request("https://md.test/tenants/t/sessions/s/query"), env)).toBeNull();
});
it("strips the api prefix while preserving authentication, query, method and streamed body", async () => {
  const request = new Request("https://md.test/api/tenants/t/sessions/s/query?check=1", { method: "POST", headers: { Authorization: "Bearer test", "X-UniDocs-CAS-Capability": "delegated" }, body: '{"kind":"getContent"}' });
  const forwarded = markdownApiRequest(request);
  expect(forwarded.url).toBe("https://md.test/tenants/t/sessions/s/query?check=1");
  expect(forwarded.method).toBe("POST");
  expect(forwarded.headers.get("Authorization")).toBe("Bearer test");
  expect(forwarded.headers.get("X-UniDocs-CAS-Capability")).toBe("delegated");
  expect(await forwarded.text()).toBe('{"kind":"getContent"}');
  const legacy = new Request("https://md.test/tenants/t/sessions/s/query");
  expect(markdownApiRequest(legacy)).toBe(legacy);
});