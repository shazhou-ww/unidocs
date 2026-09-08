import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("SQLite nonce claims are atomic, scoped and survive workerd restart", async () => {
  const built = await build({
    absWorkingDir: root,
    stdin: { contents: `
      import { PlatformNonces, createPlatformNonceStore } from "./packages/cloudflare-markdown/src/platform-nonces.ts";
      export { PlatformNonces };
      export default { async fetch(request, env) {
        const { scope, nonce, retainUntil } = await request.json();
        try {
          const claimed = await createPlatformNonceStore(env.NONCES).claim(scope, nonce, retainUntil);
          return Response.json({ claimed });
        } catch { return new Response(null, { status: 503 }); }
      } };
    `, resolveDir: root },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
    external: ["cloudflare:workers"],
  });
  const persistence = await mkdtemp(join(tmpdir(), "platform-nonces-"));
  const options = convertV4MiniflareOptions({
    host: "127.0.0.1", port: 0, log: new Log(LogLevel.WARN), resourcePersistencePath: persistence,
    workers: [{ name: "nonce-test", modules: true, script: built.outputFiles[0].text,
      compatibilityDate: "2026-08-18", durableObjects: { NONCES: { className: "PlatformNonces", useSQLite: true } } }],
  });
  let runtime;
  const claim = (scope, nonce, retainUntil) => runtime.dispatchFetch("http://test/", {
    method: "POST", body: JSON.stringify({ scope, nonce, retainUntil }),
  });
  try {
    runtime = new Miniflare(options);
    await runtime.ready;
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const attempts = await Promise.all(Array.from({ length: 12 }, () => claim("platform-editor", "fixed-nonce", deadline).then((result) => result.json())));
    expect(attempts.filter((result) => result.claimed)).toHaveLength(1);
    expect(await (await claim("platform-operator", "fixed-nonce", deadline)).json()).toEqual({ claimed: true });
    await runtime.dispose();
    runtime = undefined;
    runtime = new Miniflare(options);
    await runtime.ready;
    expect(await (await claim("platform-editor", "fixed-nonce", deadline)).json()).toEqual({ claimed: false });
    expect(await (await claim("platform-editor", "fresh-nonce", deadline)).json()).toEqual({ claimed: true });
    expect((await claim("platform-editor", "expired", Math.floor(Date.now() / 1000) - 1)).status).toBe(503);
  } finally {
    await runtime?.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
}, 60_000);