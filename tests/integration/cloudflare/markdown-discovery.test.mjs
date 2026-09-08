import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startLocalRuntime } from "../../../stacks/unidocs-cloudflare/local/runtime.mjs";
import { parseDocTypeDescriptor } from "../../../packages/gateway-common/src/admin-type-contract.ts";

test("Markdown exposes truthful discovery and the API prefix preserves existing authenticated documents", async () => {
  const ports = { gateway: 37787, markdown: 37788, cas: 37791, admin: 37792, mockOidc: 37793 };
  const persistPath = await mkdtemp(join(tmpdir(), "markdown-discovery-"));
  const bindingDefaults = { markdown: { DOC_SERVICE_ID: "markdown", DOC_STORAGE_IDENTITY: "test-markdown-storage" } };
  let runtime;
  const request = (base, path, body) => fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Connection: "close", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    runtime = await startLocalRuntime({ docTypes: ["markdown"], ports, persistPath, bindingDefaults });
    const discovery = await request(runtime.urls.markdown, "/.well-known/unidocs-doctype");
    expect(discovery.status).toBe(200);
    const descriptor = parseDocTypeDescriptor(await discovery.json());
    expect(descriptor).toMatchObject({ docType: "markdown", serviceId: "markdown", storageIdentity: "test-markdown-storage", audience: "unidocs-doc:markdown", editorProtocol: null, capabilities: { preview: false, edit: false } });
    expect(discovery.headers.get("cache-control")).toBe("no-store");
    expect((await request(runtime.urls.markdown, "/editor/")).status).toBe(501);
    expect(await (await request(runtime.urls.markdown, "/health")).json()).toMatchObject({ checks: "configuration-only" });
    const created = await request(runtime.urls.gateway, "/tenants/alice/docs/markdown/", {});
    expect(created.status).toBe(200);
    const { docId } = await created.json();
    const path = `/tenants/alice/docs/markdown/${docId}`;
    const applied = await request(runtime.urls.gateway, `${path}/apply`, { baseVersion: 1, description: "before API alias", operations: [{ kind: "setContent", payload: { content: "# Same document" } }] });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const { stackFixture, capabilityFixture } = runtime;
    await runtime.dispose(); runtime = undefined;
    runtime = await startLocalRuntime({
      docTypes: ["markdown"], ports, persistPath, stackFixture, capabilityFixture,
      bindingDefaults: { ...bindingDefaults, gateway: { DOC_SERVICES_JSON: JSON.stringify({ markdown: { serviceId: "markdown", url: `http://127.0.0.1:${ports.markdown}/api`, audience: "unidocs-doc:markdown" } }) } }
    });
    const query = await request(runtime.urls.gateway, `${path}/query`, { kind: "getContent" });
    expect(query.status, await query.clone().text()).toBe(200);
    expect(await query.json()).toMatchObject({ version: 2, data: "# Same document" });
    const next = await request(runtime.urls.gateway, `${path}/apply`, { baseVersion: 2, description: "through API alias", operations: [{ kind: "setContent", payload: { content: "# Updated" } }] });
    expect(next.status, await next.clone().text()).toBe(200);
    expect(await next.json()).toMatchObject({ version: 3 });
    expect(await (await request(runtime.urls.gateway, `${path}/query`, { kind: "getContent" })).json()).toMatchObject({ version: 3, data: "# Updated" });
    for (const prefix of ["", "/api"]) {
      const denied = await request(runtime.urls.markdown, `${prefix}/tenants/alice/sessions/nonexistent/ir`);
      expect(denied.status).toBe(401);
      await denied.text();
    }
  } finally { await runtime?.dispose(); await rm(persistPath, { recursive: true, force: true }); }
}, 120_000);