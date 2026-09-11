import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { assertServicesAvailable, expandServiceTarget, PORTAL_PORT, serviceFrontends, serviceWorkers, SERVICE_PLATFORMS, SERVICE_TARGETS } from "../../../stacks/unidocs-cloudflare/local/services.mjs";
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

test("services are available on the Cloudflare stack", () => {
  expect(() => assertServicesAvailable("cloudflare", ["portal"])).not.toThrow();
  expect(() => assertServicesAvailable("azure", [])).not.toThrow();
});

test("asking for the portal on Azure says why, and names the missing package", () => {
  expect(() => assertServicesAvailable("azure", ["portal"]))
    .toThrow(/portal is not available on the unidocs-azure stack/);
  expect(() => assertServicesAvailable("azure", ["portal"])).toThrow(/packages\/azure-portal/);
});

/**
 * Registry-coverage guard.
 *
 * `SERVICE_TARGETS` is meant to be the single row a new service adds, and it
 * is not: three sites are keyed by target name and none is derived from it.
 * Two of them can be checked against the registry directly; the third cannot,
 * so it is acknowledged by the list below. The point is that adding a row
 * fails here, loudly and with instructions, instead of failing at runtime as a
 * refusal that says the opposite of the truth or as a worker holding another
 * service's bindings.
 *
 * When a second service lands: make the three edits, then add its name here.
 */
const REGISTRY_COVERED_SERVICES = ["portal"];

const NEXT_SERVICE_INSTRUCTIONS = [
  "A new SERVICE_TARGETS row needs three hand edits, none of them derived from the registry:",
  "  1. SERVICE_PLATFORMS (stacks/unidocs-cloudflare/local/services.mjs) — without a row there,",
  "     `pnpm dev <name>` is refused with \"no adapter is registered\" on the very stack it was",
  "     just registered for.",
  "  2. serviceWorkerConfigs (stacks/unidocs-cloudflare/local/doc-types.mjs) — its bindings are",
  "     portal-shaped and handed to every service, so a new worker boots with PORTAL_ORIGIN, the",
  "     portal's Google client id and PORTAL_BOOTSTRAP_EMAIL, and none of its own. Make the",
  "     bindings per-component before shipping a second service.",
  "  3. USAGE (scripts/dev.mjs) — the `services:` list is a string literal.",
  "Then add the new target name to REGISTRY_COVERED_SERVICES in this file.",
].join("\n");

test("every service target has a platform-support row, so it is not refused on its own stack", () => {
  const missing = Object.keys(SERVICE_TARGETS).filter(name => !SERVICE_PLATFORMS[name]);
  expect(missing, `${missing.join(", ")} has no SERVICE_PLATFORMS row.\n${NEXT_SERVICE_INSTRUCTIONS}`).toEqual([]);
  // The reverse direction too: a platform row for a target that no longer
  // exists is dead configuration that reads as support.
  expect(Object.keys(SERVICE_PLATFORMS).filter(name => !SERVICE_TARGETS[name])).toEqual([]);
});

test("the dev usage line names every service target", async () => {
  const source = await readFile(new URL("../../../scripts/dev.mjs", import.meta.url), "utf8");
  const expected = `services: ${Object.keys(SERVICE_TARGETS).join(", ")}`;
  expect(source.includes(expected), `scripts/dev.mjs USAGE does not say "${expected}".\n${NEXT_SERVICE_INSTRUCTIONS}`).toBe(true);
});

test("a new service target is acknowledged before it can ship", () => {
  expect(Object.keys(SERVICE_TARGETS), NEXT_SERVICE_INSTRUCTIONS).toEqual(REGISTRY_COVERED_SERVICES);
});
