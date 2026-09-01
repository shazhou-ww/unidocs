/**
 * 网关的调用可观测性接线。
 *
 * 网关是唯一的外部入口,所以"我们对外提供的每个接口"都会产出一条 `dir:"in"`
 * 事件;它转发给 doc worker / CAS 的每一次调用产出一条 `dir:"out"`。这个文件
 * 钉住三件事:成功只记简报、失败带排错细节、拿不到响应记 status 0。
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayHandler as createCanonicalGatewayHandler } from "../src/gateway-handler.js";
import { GatewayCapabilityAuthority } from "../src/capability-authority.js";
import { MemoryGatewayDocumentDirectory } from "../src/document-directory.js";
import type { HttpCallEvent } from "@unidocs/protocol-doc";

let upstream: Server | undefined;

afterEach(async () => {
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  }
});

/** 起一个上游 doc worker,按给定状态码与响应体作答。 */
function startUpstream(status: number, body: string): Promise<number> {
  return new Promise((resolve) => {
    upstream = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream!.address();
      if (address === null || typeof address === "string") throw new Error("no port assigned");
      resolve(address.port);
    });
  });
}

/** 一个确定关闭了的端口:起一个服务器拿到端口号,立刻关掉。 */
async function closedPort(): Promise<number> {
  const port = await startUpstream(200, "{}");
  await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  return port;
}

const testIssuer = { keyId: "test-key", issue: async () => "test-token" };
const capabilityAuthority = new GatewayCapabilityAuthority({
  issuer: testIssuer,
  casIssuer: testIssuer,
  casAudience: "unidocs-cas",
  casStackId: "test-stack",
  generateJti: () => crypto.randomUUID(),
});

function handlerAgainst(port: number) {
  const events: HttpCallEvent[] = [];
  const handler = createCanonicalGatewayHandler({
    capabilityAuthority,
    casStackId: "test-stack",
    identityResolver: {
      resolve: async (_request, requestedTenantId) => ({
        userId: "authenticated-user",
        tenantId: requestedTenantId,
        canManageTenant: true,
      }),
    },
    resolveDocService: async (docType) => docType === "markdown" ? {
      serviceId: "markdown-primary",
      url: `http://127.0.0.1:${port}`,
      audience: "unidocs-doc:markdown",
    } : null,
    casFetcher: { fetch: async () => new Response(null, { status: 501 }) },
    directory: new MemoryGatewayDocumentDirectory(),
    isGatewayExposedCasRoute: () => false,
    generateId: (() => {
      const ids = ["public-doc", "internal-session"];
      return () => ids.shift()!;
    })(),
    now: () => 100,
    observe: (event) => { events.push(event); },
  } as Parameters<typeof createCanonicalGatewayHandler>[0]);
  return { handler, events };
}

function createRequest(): Request {
  return new Request("http://gw.local/tenants/tenant-1/docs/markdown/", {
    method: "POST",
    headers: {
      "content-type": "text/markdown",
      Authorization: "Bearer end-user-token",
    },
    body: "# hello",
  });
}

describe("网关调用可观测性", () => {
  it("一次成功的请求产出入站与出站各一条,且都只是简报", async () => {
    const port = await startUpstream(200, JSON.stringify({
      success: true, docId: "internal-session", version: 1,
    }));
    const { handler, events } = handlerAgainst(port);

    const res = await handler(createRequest());
    expect(res.status).toBe(200);

    const inbound = events.filter(e => e.dir === "in");
    const outbound = events.filter(e => e.dir === "out");
    expect(inbound).toHaveLength(1);
    expect(outbound).toHaveLength(1);

    expect(inbound[0]).toMatchObject({
      event: "http_call", target: "gateway", method: "POST",
      status: 200, ok: true, tenantId: "tenant-1", docType: "markdown",
    });
    expect(outbound[0]).toMatchObject({
      target: "doc:markdown", op: "create", ok: true, status: 200,
    });

    // 成功不带排错细节 —— 响应体可能是几十 MB 的文档,读它既贵又没用。
    for (const event of events) {
      expect(event.url).toBeUndefined();
      expect(event.responseBody).toBeUndefined();
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("上游返回 5xx 时,出站事件带 url 与响应体,且不含凭据头", async () => {
    const port = await startUpstream(500, JSON.stringify({ error: "boom" }));
    const { handler, events } = handlerAgainst(port);

    await handler(createRequest());

    const outbound = events.find(e => e.dir === "out")!;
    expect(outbound.ok).toBe(false);
    expect(outbound.status).toBe(500);
    expect(outbound.url).toContain("127.0.0.1");
    expect(outbound.responseBody).toContain("boom");
    expect(JSON.stringify(outbound)).not.toContain("test-token");
    expect(JSON.stringify(outbound)).not.toContain("end-user-token");
  });

  // 连不上和"拿到一个 502"是两件事。forwardToWorker 会把连不上合成成 502 交给
  // 调用方,如果只按响应码记事件,这条就会被记成一次正常的 502 响应,真正的原因
  // (超时/连接被切,浏览器侧的 Failed to fetch)就丢了。
  it("上游连不上时出站记 status 0 并带异常,入站记合成的 502", async () => {
    const port = await closedPort();
    const { handler, events } = handlerAgainst(port);

    const res = await handler(createRequest());
    expect(res.status).toBe(502);

    const outbound = events.find(e => e.dir === "out")!;
    expect(outbound.status).toBe(0);
    expect(outbound.ok).toBe(false);
    expect(outbound.error).toBeTruthy();

    const inbound = events.find(e => e.dir === "in")!;
    expect(inbound.status).toBe(502);
  });
});
