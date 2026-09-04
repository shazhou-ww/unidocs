import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyForwardedLocalArgs } from "../../../scripts/forward-local-args.mjs";
import { loadRemoteCasConfig, parseDevArgs } from "../../../scripts/unidocs-dev-config.mjs";

describe("UniDocs local CAS configuration", () => {
  it("defaults interactive development to remote CAS", () => {
    // 本地启动默认走 local CAS：不带凭据也能起来才是能用的默认值。
    expect(parseDevArgs(["docx"], {}))
      .toEqual({ casMode: "local", fontsMode: "auto", docTypes: ["docx"] });
    expect(parseDevArgs([], {}))
      .toEqual({ casMode: "local", fontsMode: "auto", docTypes: [] });
    expect(parseDevArgs(["--cas", "remote", "markdown"], {}))
      .toEqual({ casMode: "remote", fontsMode: "auto", docTypes: ["markdown"] });
    expect(parseDevArgs(["--cas", "local", "markdown"], {}))
      .toEqual({ casMode: "local", fontsMode: "auto", docTypes: ["markdown"] });
    // 环境变量仍然优先于默认值。
    expect(parseDevArgs(["docx"], { UNIDOCS_CAS_MODE: "remote" }))
      .toEqual({ casMode: "remote", fontsMode: "auto", docTypes: ["docx"] });
  });

  // 字体预置默认开着——"要人先手工跑一遍预置脚本"等于让 setText 默认关着。
  // 退出开关是给离线开发和 CI 的，照 --cas 那一套：显式参数 > 环境变量 > 默认。
  it("seeds PSD fonts by default and takes an explicit opt-out", () => {
    expect(parseDevArgs(["psd"], {}).fontsMode).toBe("auto");
    expect(parseDevArgs(["psd", "--fonts", "off"], {}).fontsMode).toBe("off");
    expect(parseDevArgs(["psd"], { UNIDOCS_PSD_FONTS: "off" }).fontsMode).toBe("off");
    // 显式参数压得住环境变量，反过来也要成立。
    expect(parseDevArgs(["psd", "--fonts", "auto"], { UNIDOCS_PSD_FONTS: "off" }).fontsMode)
      .toBe("auto");
    // --fonts 的值不能被当成 doc type 吞掉，否则 `--fonts off` 会变成"起一个
    // 叫 off 的 doc type"，报一句风马牛不相及的错。
    expect(parseDevArgs(["--fonts", "off", "psd"], {}).docTypes).toEqual(["psd"]);
    // 拼错了要当场说，别静默当成 auto —— 那正是"以为关了其实没关"。
    expect(() => parseDevArgs(["--fonts", "no"], {})).toThrow(/--fonts must be auto or off/);
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