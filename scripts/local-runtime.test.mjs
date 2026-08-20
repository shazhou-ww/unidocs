import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalRuntime } from "./local-runtime.mjs";

let runtime;

beforeAll(async () => {
  runtime = await startLocalRuntime({
    ports: { gateway: 18787, markdown: 18788, docx: 18789 },
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

test("gateway creates a markdown doc via registry workerUrl and lists it from shared D1", async () => {
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

test("registry seed works with a persist directory", async () => {
  const persistPath = await mkdtemp(join(tmpdir(), "unidocs-mf-"));
  const persisted = await startLocalRuntime({
    ports: { gateway: 18887, markdown: 18888, docx: 18889 },
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
    ports: { gateway: 18987, docx: 18989 },
  });
  try {
    expect(only.urls.markdown).toBeUndefined();

    const registry = await only.mf.getKVNamespace("REGISTRY", "unidocs-gateway");
    const { keys } = await registry.list();
    expect(keys.map((k) => k.name)).toEqual(["docType:docx"]);

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
      ports: { gateway: 19087, markdown: 19088, docx: 19089 },
    });
    await only.dispose();
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
}, 60_000);
