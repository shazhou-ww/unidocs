import { describe, expect, it, vi } from "vitest";
import { createSBlob, encodeSValue, isSBlob } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import { createCloudflareAgentPlatform } from "../src/agent-platform-do.js";

const HASH = "b".repeat(64);

/** 只记请求、按脚本回响应的假 Editor stub。 */
function fakeStub(respond: (req: Request) => Response) {
  const seen: { url: string; method: string; contentType: string | null; body: Uint8Array }[] = [];
  return {
    seen,
    stub: {
      fetch: vi.fn(async (input: string, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push({
          url: req.url,
          method: req.method,
          contentType: req.headers.get("Content-Type"),
          body: new Uint8Array(await req.clone().arrayBuffer()),
        });
        return respond(req);
      }),
    } as unknown as DurableObjectStub,
  };
}

function platformWith(stub: DurableObjectStub) {
  return createCloudflareAgentPlatform<unknown, unknown, unknown>({
    env: {},
    getEditorStub: () => stub,
    requestHeaders: () => new Headers({ "X-Tenant-Id": "t1", "X-Session-Id": "s1" }),
    editorObjectName: () => "s1",
  });
}

describe("AgentPlatform.writeBlob", () => {
  it("把字节 POST 到 /_internal/write_blob，回来的 SBlob 原样返回", async () => {
    const body = encodeSValue({ blob: createSBlob(HASH) });
    const { seen, stub } = fakeStub(() => new Response(Uint8Array.from(body).buffer, {
      headers: { "Content-Type": SValueContentType },
    }));
    const blob = await platformWith(stub).writeBlob({
      data: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
    });
    expect(isSBlob(blob)).toBe(true);
    expect(blob.hash).toBe(HASH);
    expect(seen[0].url).toBe("http://editor/_internal/write_blob");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].contentType).toBe("image/png");
    expect(Array.from(seen[0].body)).toEqual([137, 80, 78, 71]);
  });

  it("编辑器返回非 2xx 时抛错，不静默吞掉", async () => {
    const { stub } = fakeStub(() => Response.json({ success: false, error: "no capability" }, { status: 403 }));
    await expect(platformWith(stub).writeBlob({
      data: new Uint8Array([1]), contentType: "image/png",
    })).rejects.toThrow(/write blob/i);
  });

  it("转发头原样带过去 —— 身份和 capability 不能丢", async () => {
    const body = encodeSValue({ blob: createSBlob(HASH) });
    const { stub } = fakeStub(() => new Response(Uint8Array.from(body).buffer, {
      headers: { "Content-Type": SValueContentType },
    }));
    await platformWith(stub).writeBlob({ data: new Uint8Array([1]), contentType: "image/png" });
    const req = new Request((stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
      (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit);
    expect(req.headers.get("X-Tenant-Id")).toBe("t1");
    expect(req.headers.get("X-Session-Id")).toBe("s1");
  });
});
