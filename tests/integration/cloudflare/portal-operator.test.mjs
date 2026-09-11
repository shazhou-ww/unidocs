import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, test } from "vitest";

test("Operator destination is the bound Worker, not request DNS, with redirect and size defenses", async () => {
  const built = await build({
    stdin: {
      contents: `import { createBoundOperatorTransport } from './packages/cloudflare-portal/src/operator-transport.ts';
        export default { async fetch(request, env) {
          const input = new URL(request.url);
          const baseUrl = 'https://not-publicly-resolvable.invalid/operator';
          const transport = createBoundOperatorTransport([{ baseUrl, probePath: '/probe', service: env.OPERATOR }]);
          try {
            const result = input.searchParams.has('probe')
              ? await transport.probe(baseUrl, new TextEncoder().encode('{}'), { 'x-unidocs-test-mode': input.searchParams.get('probe') })
              : await transport.discovery(input.searchParams.get('target') ?? baseUrl);
            return new Response(result.body, { headers: { 'content-type': 'application/json' } });
          } catch { return new Response('operator_request_failed', { status: 422 }); }
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
  });
  const miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [
    {
      name: "portal-operator-transport", modules: true, script: built.outputFiles[0].text,
      compatibilityDate: "2026-08-18", serviceBindings: { OPERATOR: "bound-operator" },
    },
    {
      name: "bound-operator", modules: true, compatibilityDate: "2026-08-18",
      script: `export default { async fetch(request) {
        const mode = request.headers.get('x-unidocs-test-mode');
        if (mode === 'redirect') return Response.redirect('http://169.254.169.254/latest/meta-data', 302);
        if (mode === 'large') return new Response(new Uint8Array(65537), { headers: { 'content-type': 'application/json' } });
        return Response.json({ bound: true, url: request.url, method: request.method,
          authorization: request.headers.get('authorization'), cookie: request.headers.get('cookie') });
      } };`,
    },
  ] }));
  try {
    const response = await miniflare.dispatchFetch("https://portal.test/", { headers: { authorization: "Bearer do-not-forward", cookie: "do-not-forward" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bound: true, url: "https://not-publicly-resolvable.invalid/operator/.well-known/unidocs-operator", method: "GET", authorization: null, cookie: null });
    const probe = await miniflare.dispatchFetch("https://portal.test/?probe=normal");
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ bound: true, method: "POST", url: "https://not-publicly-resolvable.invalid/operator/probe" });
    for (const query of ["probe=redirect", "probe=large", "target=https://169.254.169.254", "target=https://not-publicly-resolvable.invalid/other"]) {
      expect((await miniflare.dispatchFetch(`https://portal.test/?${query}`)).status).toBe(422);
    }
  } finally {
    await miniflare.dispose();
  }
});

test("Portal validation completes a signed probe through a real Service Binding", async () => {
  const keyHex = "0123456789abcdef".repeat(4);
  const portal = await build({
    stdin: {
      contents: `import { createBoundOperatorTransport } from './packages/cloudflare-portal/src/operator-transport.ts';
        import { createOperatorValidationService } from './packages/portal-service/src/index.ts';
        const baseUrl = 'https://not-publicly-resolvable.invalid';
        export default { async fetch(_request, env) {
          const key = Uint8Array.from(env.KEY.match(/../g), pair => Number.parseInt(pair, 16));
          const transport = createBoundOperatorTransport([{ baseUrl, probePath: '/operator/probe', service: env.OPERATOR }]);
          let failedPhase = null;
          const repository = { replay: async () => null, listDocumentContractIdxs: async () => [0], publish: async command => command.validation,
            recordFailure: async command => { failedPhase = command.phase; }, get: async () => null };
          const service = createOperatorValidationService(repository, transport, { resolve: async value => value === baseUrl ? key : null },
            { now: () => new Date('2026-09-11T12:00:00.000Z'), id: () => 'validation-1', challenge: () => new Uint8Array(32).fill(7) });
          try { return Response.json(await service.validate({ memberId: 'admin', identity: { issuer: 'issuer', subject: 'subject', email: 'admin@example.com', authenticatedAt: 1 }, transport: 'bearer' },
            { baseUrl, expectedDocumentType: 'dt-markdown', expectedConfigEtag: null }, 'key-1', 'request-1'));
          } catch (error) { return Response.json({ name: error?.name, code: error?.code, phase: failedPhase }, { status: 422 }); }
        } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
  });
  const operator = await build({
    stdin: {
      contents: `import { markdownOperatorEndpoint } from './packages/cloudflare-markdown/src/operator-endpoint.ts';
        export default { fetch(request, env) { return markdownOperatorEndpoint(request, { MARKDOWN_OPERATOR_HMAC_KEY: env.KEY, MARKDOWN_OPERATOR_DOCUMENT_TYPE: 'dt-markdown' }, () => new Date('2026-09-11T12:00:00.000Z')); } };`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2024",
  });
  const miniflare = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: "portal-signed-probe", modules: true, script: portal.outputFiles[0].text, compatibilityDate: "2026-08-18", bindings: { KEY: keyHex }, serviceBindings: { OPERATOR: "markdown-signed-probe" } },
    { name: "markdown-signed-probe", modules: true, script: operator.outputFiles[0].text, compatibilityDate: "2026-08-18", bindings: { KEY: keyHex } },
  ] }));
  try {
    const response = await miniflare.dispatchFetch("https://portal.test/");
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    expect(JSON.parse(responseText)).toMatchObject({ validationId: "validation-1", documentType: "dt-markdown", baseUrl: "https://not-publicly-resolvable.invalid",
      expectedConfigEtag: expect.stringMatching(/^"sha256-[A-Za-z0-9_-]{43}"$/), descriptor: { declaredOperatorId: "markdown-primary", supportedDocumentContracts: { "dt-markdown": [0] } } });
  } finally {
    await miniflare.dispose();
  }
});