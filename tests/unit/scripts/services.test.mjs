import { expect, test } from "vitest";
import { expandServiceTarget, PORTAL_PORT, serviceFrontends, serviceWorkers, SERVICE_TARGETS } from "../../../stacks/unidocs-cloudflare/local/services.mjs";
import { parseTargets } from "../../../stacks/unidocs-cloudflare/local/doc-types.mjs";

test("portal is an umbrella that expands to every component it owns", () => {
  const components = expandServiceTarget("portal");
  expect(components.length).toBeGreaterThan(0);
  expect(components.every(component => component.target === "portal")).toBe(true);
  expect(components.map(component => component.name)).toContain("portal");
});

test("every registered component declares either a worker entry or a frontend directory", () => {
  for (const [target, components] of Object.entries(SERVICE_TARGETS)) {
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(component.name, `${target} component is unnamed`).toBeTruthy();
      expect(Boolean(component.entry) || Boolean(component.web), `${component.name} declares neither entry nor web`).toBe(true);
      if (component.entry) expect(component.port, `${component.name} has an entry but no port`).toBeTypeOf("number");
      if (component.web) expect(component.web.dir && component.web.port, `${component.name} web is incomplete`).toBeTruthy();
    }
  }
});

test("workers and frontends are selected separately, so a target may have only one kind", () => {
  const workers = serviceWorkers(["portal"]);
  expect(workers.every(component => component.entry)).toBe(true);
  expect(serviceFrontends(["portal"]).every(component => component.web)).toBe(true);
});

test("an unknown service target names the ones that exist", () => {
  expect(() => expandServiceTarget("nope")).toThrow(/Unknown service target: nope/);
  expect(() => expandServiceTarget("nope")).toThrow(/portal/);
});

test("positional arguments split into document types and service targets", () => {
  expect(parseTargets(["portal"])).toEqual({ docTypes: [], services: ["portal"] });
  expect(parseTargets(["portal", "psd"])).toEqual({ docTypes: ["psd"], services: ["portal"] });
  expect(parseTargets(["psd", "portal"])).toEqual({ docTypes: ["psd"], services: ["portal"] });
});

test("no arguments still means every document type and no service", () => {
  const { docTypes, services } = parseTargets([]);
  expect(docTypes).toEqual(["markdown", "docx", "psd"]);
  expect(services).toEqual([]);
});

test("duplicates collapse and order is preserved within each kind", () => {
  expect(parseTargets(["psd", "portal", "psd", "portal"])).toEqual({ docTypes: ["psd"], services: ["portal"] });
  expect(parseTargets(["psd", "portal", "markdown"])).toEqual({ docTypes: ["psd", "markdown"], services: ["portal"] });
});

test("an unknown positional names both kinds of valid target", () => {
  expect(() => parseTargets(["nope"])).toThrow(/Unknown target: nope/);
  expect(() => parseTargets(["nope"])).toThrow(/markdown/);
  expect(() => parseTargets(["nope"])).toThrow(/portal/);
});

// Moved from the integration file's "reserves the port the registry
// declares..." test, which compared this constant against a literal and
// needed no running Miniflare to do it.
test("PORTAL_PORT is pinned at 8795", () => {
  expect(PORTAL_PORT).toBe(8795);
});

test("the registry stays dependency-free so argv validation costs nothing", async () => {
  const source = await import("node:fs/promises").then(fs =>
    fs.readFile(new URL("../../../stacks/unidocs-cloudflare/local/services.mjs", import.meta.url), "utf8"));
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(match => match[1]);
  expect(imports.filter(specifier => specifier !== "node:path")).toEqual([]);
});
