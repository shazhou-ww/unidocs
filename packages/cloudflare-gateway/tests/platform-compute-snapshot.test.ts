import { beforeAll, describe, expect, it, vi } from "vitest";
import { CasAuthorizationHeader, importPlatformHmacKey } from "@unidocs/service-auth";
import { SValueContentType } from "@unidocs/protocol";
import { decodeSValue, encodeSValue } from "@unidocs/svalue-codec";
import { createPlatformComputeSnapshot } from "../src/platform-compute-snapshot.js";

const invocation = { requestId: "request-1", actorId: "actor-1", tenantId: "tenant-1", docId: "doc-1", docType: "markdown" };
const context = { contextId: "context-1", sequence: 2 };
let key: CryptoKey;

beforeAll(async () => { key = await importPlatformHmacKey(new Uint8Array(32).fill(7)); });

function setup(response: () => Response) {
  const computeFetcher = { fetch: vi.fn(async (input: string | Request) => {
    const request = input instanceof Request ? input : new Request(input);
    expect(request.redirect).toBe("manual");
    expect(request.headers.get(CasAuthorizationHeader)).toBe("Bearer compute-token");
    expect(decodeSValue(new Uint8Array(await request.arrayBuffer()))).toEqual({ invocation, context });
    return response();
  }) };
  const snapshot = createPlatformComputeSnapshot({
    computeOrigin: "https://compute.example", snapshotPath: "/v1/editor/snapshot", computeFetcher,
    hmacKey: { keyId: "key-1", platformId: "platform-1", environment: "test", serviceId: "markdown-compute", role: "editor", key },
    casStackId: "stack-1", casFetcher: { fetch: vi.fn() },
    getComputeAuthorization: async () => "Bearer compute-token",
    getPlatformAuthorization: async () => "Bearer platform-token",
    now: () => 100,
  }, invocation, context);
  return { snapshot, computeFetcher };
}

describe("platform compute snapshot", () => {
  it("signs the exact context request and decodes a successful SValue state", async () => {
    const state = { content: "# 已保存" };
    const { snapshot } = setup(() => new Response(encodeSValue({ success: true, data: state }), {
      status: 200, headers: { "content-type": SValueContentType },
    }));
    await expect(snapshot.capture()).resolves.toEqual(state);
  });

  it("rejects redirects before accepting their response body", async () => {
    const { snapshot } = setup(() => new Response(null, { status: 302, headers: { location: "https://attacker.example" } }));
    await expect(snapshot.capture()).rejects.toThrow("redirect rejected");
  });

  it("bounds streamed responses without relying on Content-Length", async () => {
    const { snapshot } = setup(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": SValueContentType } }));
    await expect(snapshot.capture()).rejects.toThrow("exceeds limit");
  });
});