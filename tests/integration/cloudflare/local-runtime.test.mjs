import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAS_ACCESS_KEY,
  startLocalRuntime,
} from "../../../scripts/local-runtime.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startLocalRuntime({
    docTypes: ["markdown", "docx"],
    ports: { gateway: 18787, markdown: 18788, docx: 18789, cas: 18790 },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

test("unregistered doc types are rejected", async () => {
  const res = await fetch(`${runtime.urls.gateway}/users/alice/docs/pdf/`, {
    method: "POST",
  });
  expect(res.status).toBe(404);
  await expect(res.json()).resolves.toMatchObject({
    error: "Unknown document type: pdf",
  });
});

test("gateway creates a markdown doc via static registration and lists it", async () => {
  const create = await fetch(`${runtime.urls.gateway}/users/alice/docs/markdown/`, {
    method: "POST",
  });
  expect(create.ok).toBe(true);
  const created = await create.json();
  expect(created.success).toBe(true);
  expect(created.docId).toEqual(expect.any(String));

  const list = await fetch(`${runtime.urls.gateway}/users/alice/docs/markdown/`);
  expect(list.ok).toBe(true);
  const listed = await list.json();
  expect(listed.success).toBe(true);
  expect(listed.data.map((row) => row.doc_id)).toContain(created.docId);
});

test("gateway creates a docx doc via a separate registered workerUrl", async () => {
  const create = await fetch(`${runtime.urls.gateway}/users/alice/docs/docx/`, {
    method: "POST",
  });
  expect(create.ok).toBe(true);
  const created = await create.json();
  expect(created.success).toBe(true);

  const list = await fetch(`${runtime.urls.gateway}/users/alice/docs/docx/`);
  const listed = await list.json();
  expect(listed.data.map((row) => row.doc_id)).toContain(created.docId);
});

// 过渡形态(阶段 4 删除):Azure 栈的 CAS_BASE_URL 要打到这个直连端口
// (见 doc-types.mjs 的 CAS_PORT 与 buildWorkers 里的 unsafeDirectSockets)。
// 这条测试证明 CAS worker 现在在 Miniflare 进程外可达,而不只是通过
// gateway 的 service binding。
test("the CAS worker is directly reachable on its own port, outside the gateway", async () => {
  expect(runtime.urls.cas).toBe("http://127.0.0.1:18790");

  const res = await fetch(`${runtime.urls.cas}/tenants/tenant-a/cas/usage`, {
    headers: { "X-Internal-Token": CAS_ACCESS_KEY },
  });
  expect(res.status).toBe(200);
});

test("a directly reached Doc service rejects requests without its service credential", async () => {
  const res = await fetch(`${runtime.urls.markdown}/sessions/untrusted-session/status`, {
    headers: {
      "X-Tenant-Id": "alice",
      "X-Session-Id": "untrusted-session",
    },
  });
  expect(res.status).toBe(403);
});

test("static registration works with a persist directory", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-mf-"));
  const persisted = await startLocalRuntime({
    docTypes: ["markdown", "docx"],
    ports: { gateway: 18887, markdown: 18888, docx: 18889, cas: 18890 },
    persistPath,
  });
  try {
    const create = await fetch(`${persisted.urls.gateway}/users/bob/docs/markdown/`, {
      method: "POST",
    });
    expect(create.ok).toBe(true);
  } finally {
    await persisted.dispose();
  }
}, 60_000);

test("only the selected doc types are started and routable", async () => {
  const only = await startLocalRuntime({
    docTypes: ["docx"],
    ports: { gateway: 18987, docx: 18989, cas: 18990 },
  });
  try {
    expect(only.urls.markdown).toBeUndefined();

    const bindings = await only.mf.getBindings("unidocs-gateway");
    expect(Object.keys(JSON.parse(bindings.DOC_SERVICES_JSON))).toEqual(["docx"]);

    const create = await fetch(`${only.urls.gateway}/users/alice/docs/docx/`, {
      method: "POST",
    });
    expect(create.ok).toBe(true);

    const unstarted = await fetch(`${only.urls.gateway}/users/alice/docs/markdown/`, {
      method: "POST",
    });
    expect(unstarted.status).toBe(404);
    await expect(unstarted.json()).resolves.toMatchObject({
      error: "Unknown document type: markdown",
    });
  } finally {
    await only.dispose();
  }
}, 60_000);

test("a port belonging to an unselected doc type stays available", async () => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(19088, "127.0.0.1", resolve));
  try {
    const only = await startLocalRuntime({
      docTypes: ["docx"],
      ports: { gateway: 19087, markdown: 19088, docx: 19089, cas: 19090 },
    });
    await only.dispose();
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
}, 60_000);
