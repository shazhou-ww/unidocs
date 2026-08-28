import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyForwardedLocalArgs } from "../../../scripts/forward-local-args.mjs";
import { loadRemoteCasConfig, parseDevArgs } from "../../../scripts/unidocs-dev-config.mjs";

describe("UniDocs local CAS configuration", () => {
  it("defaults interactive development to remote CAS", () => {
    // 本地启动默认走 local CAS：不带凭据也能起来才是能用的默认值。
    expect(parseDevArgs(["docx"], {})).toEqual({ casMode: "local", docTypes: ["docx"] });
    expect(parseDevArgs([], {})).toEqual({ casMode: "local", docTypes: [] });
    expect(parseDevArgs(["--cas", "remote", "markdown"], {}))
      .toEqual({ casMode: "remote", docTypes: ["markdown"] });
    expect(parseDevArgs(["--cas", "local", "markdown"], {}))
      .toEqual({ casMode: "local", docTypes: ["markdown"] });
    // 环境变量仍然优先于默认值。
    expect(parseDevArgs(["docx"], { UNIDOCS_CAS_MODE: "remote" }))
      .toEqual({ casMode: "remote", docTypes: ["docx"] });
  });

  it("loads a persistent developer stack fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "unidocs-cas-config-"));
    const directory = join(root, ".wrangler", "unidocs");
    await mkdir(directory, { recursive: true });
    const fixture = {
      stackId: "unidocs-dev-lee",
      issuer: "https://issuer.example/lee",
      audience: "unidocs-cas-dev-lee",
      kid: "dev-1",
      privateKeyPkcs8: "private",
      jwks: { keys: [{ kid: "dev-1" }] },
    };
    await writeFile(join(directory, "stack.json"), JSON.stringify(fixture));
    await expect(loadRemoteCasConfig({
      root,
      env: { UNIDOCS_CAS_ORIGIN: "https://unicas.example" },
    })).resolves.toMatchObject({
      origin: "https://unicas.example",
      stackFixture: fixture,
    });
  });

  it("does not silently fall back when credentials are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "unidocs-cas-config-"));
    await expect(loadRemoteCasConfig({ root, env: {} }))
      .rejects.toThrow(/use --cas local/);
  });

  it("forwards local arguments through a Docker Compose environment", () => {
    const argv = ["node", "dev.mjs"];
    const env = { UNIDOCS_LOCAL_ARGS_JSON: '["docx","--cas","local"]' };
    applyForwardedLocalArgs(argv, env);
    expect(argv.slice(2)).toEqual(["docx", "--cas", "local"]);
    expect(env).not.toHaveProperty("UNIDOCS_LOCAL_ARGS_JSON");
  });
});