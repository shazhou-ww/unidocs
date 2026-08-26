import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPKCS8 } from "jose";
import { afterEach, describe, expect, test } from "vitest";
import {
  generateLocalCapabilityKeys,
  parseArgs,
} from "../../../scripts/generate-local-capability-keys.mjs";

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("local capability key generation", () => {
  test("writes an ES256 private key and matching public-only JWKS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unidocs-capability-"));
    cleanup.push(directory);
    const output = join(directory, "fixture.json");
    const result = await generateLocalCapabilityKeys({
      output,
      issuer: "unidocs-gateway:test-local",
      kid: "local-key-1",
    });
    const fixture = JSON.parse(await readFile(output, "utf8"));

    expect(result).toEqual({
      output,
      issuer: "unidocs-gateway:test-local",
      kid: "local-key-1",
    });
    expect(fixture).toMatchObject({
      issuer: "unidocs-gateway:test-local",
      algorithm: "ES256",
      kid: "local-key-1",
      jwks: { keys: [{ kid: "local-key-1", alg: "ES256", use: "sig" }] },
    });
    expect(fixture.privateKeyPkcs8).toContain("BEGIN PRIVATE KEY");
    expect(fixture.jwks.keys[0]).not.toHaveProperty("d");
    await expect(importPKCS8(fixture.privateKeyPkcs8, "ES256")).resolves.toBeDefined();
  });

  test("does not overwrite an existing fixture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unidocs-capability-"));
    cleanup.push(directory);
    const output = join(directory, "fixture.json");
    const options = { output, issuer: "issuer", kid: "kid" };
    await generateLocalCapabilityKeys(options);
    await expect(generateLocalCapabilityKeys(options)).rejects.toMatchObject({ code: "EEXIST" });
  });

  test("parses explicit non-secret metadata options", () => {
    expect(parseArgs([
      "--output", ".wrangler/capability/dev.json",
      "--issuer", "unidocs-gateway:dev",
      "--kid", "dev-key",
    ])).toEqual({
      output: ".wrangler/capability/dev.json",
      issuer: "unidocs-gateway:dev",
      kid: "dev-key",
    });
  });
});