import { expect, test } from "vitest";
import {
  buildWorkers,
  bundleTargets,
  DOC_TYPES,
  parseDocTypes,
  registryEntries,
  resolvePorts,
} from "./doc-types.mjs";

test("parseDocTypes defaults to every registered doc type", () => {
  expect(parseDocTypes([])).toEqual(["markdown", "docx"]);
});

test("parseDocTypes selects the doc types named as positional args", () => {
  expect(parseDocTypes(["docx"])).toEqual(["docx"]);
});

test("parseDocTypes keeps the order the args were given in", () => {
  expect(parseDocTypes(["docx", "markdown"])).toEqual(["docx", "markdown"]);
});

test("parseDocTypes collapses a repeated doc type", () => {
  expect(parseDocTypes(["docx", "docx"])).toEqual(["docx"]);
});

test("parseDocTypes rejects an unknown doc type", () => {
  expect(() => parseDocTypes(["pdf"])).toThrow(/pdf/);
});

test("every registered doc type carries the fields the runtime needs", () => {
  for (const [name, spec] of Object.entries(DOC_TYPES)) {
    expect(spec.entry, `${name}.entry`).toBeTruthy();
    expect(spec.worker, `${name}.worker`).toBeTruthy();
    expect(spec.editorClass, `${name}.editorClass`).toBeTruthy();
    expect(spec.operatorClass, `${name}.operatorClass`).toBeTruthy();
    expect(typeof spec.port, `${name}.port`).toBe("number");
  }
});

test("resolvePorts only allocates ports for the gateway and selected types", () => {
  expect(resolvePorts(["docx"])).toEqual({ gateway: 8787, docx: 8789 });
});

test("resolvePorts lets a caller override individual ports", () => {
  expect(resolvePorts(["markdown"], { gateway: 18787, markdown: 18788 }))
    .toEqual({ gateway: 18787, markdown: 18788 });
});

test("bundleTargets builds the gateway plus only the selected types", () => {
  expect(bundleTargets(["docx"]).map((t) => t.outfile))
    .toEqual(["gateway.js", "docx.js"]);
});

test("buildWorkers always includes the gateway", () => {
  const workers = buildWorkers({
    docTypes: [],
    host: "127.0.0.1",
    ports: { gateway: 8787 },
    bundleDir: "/b",
  });
  expect(workers.map((w) => w.name)).toEqual(["unidocs-gateway"]);
});

test("buildWorkers omits doc types that were not selected", () => {
  const workers = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { gateway: 8787, docx: 8789 },
    bundleDir: "/b",
  });
  expect(workers.map((w) => w.name)).toEqual(["unidocs-gateway", "unidocs-docx"]);
});

test("buildWorkers binds each selected type's own DO classes and socket", () => {
  const [, docx] = buildWorkers({
    docTypes: ["docx"],
    host: "127.0.0.1",
    ports: { gateway: 8787, docx: 8789 },
    bundleDir: "/b",
  });
  expect(docx.durableObjects).toEqual({
    DOCX_EDITOR: { className: "DocxEditor", useSQLite: true },
    DOCX_OPERATOR: { className: "DocxOperator", useSQLite: true },
  });
  expect(docx.unsafeDirectSockets).toEqual([{ host: "127.0.0.1", port: 8789 }]);
  expect(docx.scriptPath).toBe("/b/docx.js");
});

test("registryEntries seeds only the selected doc types", () => {
  expect(
    registryEntries(["docx"], {
      gateway: "http://h:8787",
      docx: "http://h:8789",
    }),
  ).toEqual([["docType:docx", JSON.stringify({ workerUrl: "http://h:8789" })]]);
});
