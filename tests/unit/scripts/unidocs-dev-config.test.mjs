import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyForwardedLocalArgs } from "../../../scripts/forward-local-args.mjs";
import {
  loadRemoteCasConfig,
  localCredentialsPath,
  parseDevArgs,
  writeLocalCredentials,
} from "../../../scripts/unidocs-dev-config.mjs";

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

  // 字体预置默认开着。内置字体随包发行之后这**不再**是"否则 setText 默认关着"
  // ——`--fonts off` 之后索引里仍有内置那两条，中英混排照样排得出来。默认开着
  // 是为了本地多拿全量 NotoSansSC 与示例 PSD 点名的 JosefinSans-Bold（理由写在
  // scripts/unidocs-dev-config.mjs 的 fontsMode 那段）。
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

// 字体登记表下沉成中立契约之后，两个栈都挂着 `/tenants/{t}/fonts`，两个栈都
// 需要一份能直连 doc service 的凭据。这一组守的是那份凭据「写到哪儿、CAS 指向
// 哪儿」——两处错了都不会报错，只会静默灌进另一个栈 / 另一个 CAS。
describe("local credentials", () => {
  const capabilityFixture = {
    issuer: "unidocs-gateway:local",
    kid: "cap-1",
    privateKeyPkcs8: "cap-private",
  };
  const stackFixture = {
    stackId: "unidocs-azure",
    issuer: "unidocs-azure:local",
    audience: "unidocs-cas-azure",
    kid: "stack-1",
    privateKeyPkcs8: "stack-private",
  };

  it("gives each stack its own file so a simultaneous run can't clobber the other", async () => {
    const root = await mkdtemp(join(tmpdir(), "unidocs-creds-"));
    expect(localCredentialsPath(root, "cloudflare"))
      .toBe(join(root, ".wrangler", "unidocs", "local-credentials.json"));
    expect(localCredentialsPath(root, "azure"))
      .toBe(join(root, ".azure-runtime", "local-credentials.json"));
    // 拼错栈名要当场说。静默落到某个默认路径的后果是"灌了但没灌到这个栈"。
    expect(() => localCredentialsPath(root, "gcp")).toThrow(/unknown platform/);
  });

  // Cloudflare 那一路的 UniCAS edge 在 `urls.edge`，Azure 那一路是一个嵌入的
  // 中间件运行时。写错的表现不是报错：脚本会把字节灌进一个 doc service 读不到
  // 的 CAS，索引里的哈希于是全都指向空气。
  it("resolves the CAS origin from whichever runtime shape it was handed", async () => {
    const root = await mkdtemp(join(tmpdir(), "unidocs-creds-"));
    const cfPath = await writeLocalCredentials({
      root,
      platform: "cloudflare",
      runtime: {
        urls: { psd: "http://127.0.0.1:8790", edge: "http://127.0.0.1:8794" },
        capabilityFixture,
        stackFixture,
      },
    });
    expect(cfPath).toBe(localCredentialsPath(root, "cloudflare"));
    expect(JSON.parse(await readFile(cfPath, "utf8"))).toMatchObject({
      psdUrl: "http://127.0.0.1:8790",
      casOrigin: "http://127.0.0.1:8794",
      docAudience: "unidocs-doc:psd",
      doc: capabilityFixture,
      stack: { stackId: "unidocs-azure", refDomain: "doc" },
    });

    const azurePath = await writeLocalCredentials({
      root,
      platform: "azure",
      runtime: {
        urls: { psd: "http://127.0.0.1:41820" },
        middleware: { urls: { edge: "http://127.0.0.1:36894" } },
        capabilityFixture,
        stackFixture,
      },
    });
    expect(azurePath).toBe(localCredentialsPath(root, "azure"));
    expect(JSON.parse(await readFile(azurePath, "utf8"))).toMatchObject({
      psdUrl: "http://127.0.0.1:41820",
      casOrigin: "http://127.0.0.1:36894",
    });

    // `--cas remote` 时调用方显式给 origin，它压过两种内嵌形状。
    const remotePath = await writeLocalCredentials({
      root,
      platform: "azure",
      casOrigin: "https://unicas.example",
      runtime: {
        urls: { psd: "http://127.0.0.1:41820" },
        middleware: { urls: { edge: "http://127.0.0.1:36894" } },
        capabilityFixture,
        stackFixture,
      },
    });
    expect(JSON.parse(await readFile(remotePath, "utf8")).casOrigin)
      .toBe("https://unicas.example");
  });
});
