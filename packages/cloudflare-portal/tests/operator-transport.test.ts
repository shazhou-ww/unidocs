import { afterEach, describe, expect, test, vi } from "vitest";
import { createBoundOperatorTransport, OPERATOR_IO_LIMITS, OperatorTransportError } from "../src/operator-transport.js";

const baseUrl = "https://operator.example/service";
const probePath = "/probe";
function setup(timeoutMs?: number) {
  const fetcher = vi.fn(async (_request: Request): Promise<Response> => Response.json({ protocol: "test" }, { headers: { etag: '"v1"' } }));
  const transport = createBoundOperatorTransport([{ baseUrl, probePath, service: { fetch: fetcher } }], timeoutMs);
  return { transport, fetcher };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bound Operator transport", () => {
  test("uses only the configured binding and exact discovery path", async () => {
    const publicFetch = vi.fn(() => { throw new Error("Public fetch must not run"); });
    vi.stubGlobal("fetch", publicFetch);
    const { transport, fetcher } = setup();
    const result = await transport.discovery(baseUrl);
    expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ protocol: "test" });
    expect(result.etag).toBe('"v1"');
    const [request] = fetcher.mock.calls[0];
    expect(request.url).toBe(`${baseUrl}/.well-known/unidocs-operator`);
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("manual");
    expect(request.credentials).toBe("omit");
    const headerNames: string[] = [];
    request.headers.forEach((_value, name) => headerNames.push(name));
    expect(headerNames).toEqual(["accept"]);
    expect(publicFetch).not.toHaveBeenCalled();
  });

  test.each([
    "http://operator.example/service", "https://127.0.0.1", "https://169.254.169.254/latest/meta-data",
    "https://[::1]", "https://2130706433", "https://operator.example.evil/service",
    "https://user:pass@operator.example/service", "https://operator.example/service/",
    "https://operator.example/service?next=internal", "https://operator.example/service#part",
    "https://operator.example:8443/service", "https://operator.example./service",
    "https://operator.example/service/../service", "https://operator.example/%73ervice",
    "https://operator.example/service\\evil", "https://operator.example/other",
  ])("rejects nonregistered or noncanonical target %s without I/O", async target => {
    const { transport, fetcher } = setup();
    await expect(transport.discovery(target)).rejects.toBeInstanceOf(OperatorTransportError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("sends only a bounded probe body and explicitly permitted proof headers", async () => {
    const { transport, fetcher } = setup();
    const body = new TextEncoder().encode('{"nonce":"test"}');
    await transport.probe(baseUrl, body, { "x-unidocs-signature": "fixture-proof" });
    const [request] = fetcher.mock.calls[0];
    expect(request.url).toBe(`${baseUrl}/probe`);
    expect(request.method).toBe("POST");
    expect(await request.text()).toBe('{"nonce":"test"}');
    expect(request.headers.get("x-unidocs-signature")).toBe("fixture-proof");
    await expect(transport.probe(baseUrl, body, { authorization: "Bearer secret" })).rejects.toBeInstanceOf(OperatorTransportError);
    await expect(transport.probe(baseUrl, body, { cookie: "secret" })).rejects.toBeInstanceOf(OperatorTransportError);
    await expect(transport.probe(baseUrl, new Uint8Array(OPERATOR_IO_LIMITS.probeBytes + 1), {})).rejects.toBeInstanceOf(OperatorTransportError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("returns only the fixed probe signature response header", async () => {
    const { transport, fetcher } = setup();
    fetcher.mockResolvedValue(Response.json({ protocol: "receipt" }, { headers: {
      "x-unidocs-probe-signature": "a".repeat(43), "x-unidocs-other": "hidden", "set-cookie": "secret=value",
    } }));
    const response = await transport.probe(baseUrl, new TextEncoder().encode("{}"), {});
    expect(response.proofHeaders).toEqual({ "x-unidocs-probe-signature": "a".repeat(43) });
  });

  test.each([
    { "x-unidocs-cas-authorization": "secret" },
    { "x-unidocs-platform-authorization": "secret" },
    { "x-unidocs-signature": "x".repeat(1025) },
    { "x-unidocs-signature": "invalid\nheader" },
    Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`x-unidocs-proof-${index}`, "x".repeat(1024)])),
  ])("rejects delegated credentials or excessive proof headers %# before I/O", async headers => {
    const { transport, fetcher } = setup();
    await expect(transport.probe(baseUrl, new Uint8Array([123, 125]), headers)).rejects.toBeInstanceOf(OperatorTransportError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("configuration cannot silently override bindings or increase the timeout", () => {
    const target = { baseUrl, probePath, service: { fetch: async () => Response.json({}) } };
    expect(() => createBoundOperatorTransport([target, target])).toThrow("Duplicate Operator target");
    for (const timeout of [0, -1, 1.5, NaN, 5001]) expect(() => createBoundOperatorTransport([target], timeout)).toThrow(RangeError);
  });

  test.each([301, 302, 307, 308, 404, 500])("rejects HTTP %s without a follow-up request", async status => {
    const { transport, fetcher } = setup();
    let cancelled = false;
    fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: "http://169.254.169.254", "content-type": "application/json" } }));
    await expect(transport.discovery(baseUrl)).rejects.toBeInstanceOf(OperatorTransportError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  test("counts actual response bytes regardless of Content-Length and cancels overflow", async () => {
    const { transport, fetcher } = setup();
    let cancelled = false;
    fetcher.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(OPERATOR_IO_LIMITS.responseBytes + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json", "content-length": "1" } }));
    await expect(transport.discovery(baseUrl)).rejects.toBeInstanceOf(OperatorTransportError);
    expect(cancelled).toBe(true);
  });

  test("accepts the exact response limit and rejects non-JSON media types", async () => {
    const { transport, fetcher } = setup();
    fetcher.mockResolvedValue(new Response(new Uint8Array(OPERATOR_IO_LIMITS.responseBytes), { headers: { "content-type": "application/json; charset=utf-8" } }));
    expect((await transport.discovery(baseUrl)).body).toHaveLength(OPERATOR_IO_LIMITS.responseBytes);
    fetcher.mockResolvedValue(new Response("html", { headers: { "content-type": "text/html" } }));
    await expect(transport.discovery(baseUrl)).rejects.toBeInstanceOf(OperatorTransportError);
  });

  test("deadline aborts a fetch that ignores its AbortSignal", async () => {
    vi.useFakeTimers();
    const { transport, fetcher } = setup(20);
    fetcher.mockImplementation(() => new Promise(() => {}));
    const result = expect(transport.discovery(baseUrl)).rejects.toBeInstanceOf(OperatorTransportError);
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(fetcher.mock.calls[0][0].signal.aborted).toBe(true);
  });

  test("deadline also covers a stalled body and ignores a hanging cancel hook", async () => {
    vi.useFakeTimers();
    const { transport, fetcher } = setup(20);
    let cancelled = false;
    fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { headers: { "content-type": "application/json" } }));
    const result = expect(transport.discovery(baseUrl)).rejects.toBeInstanceOf(OperatorTransportError);
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(cancelled).toBe(true);
  });

  test("late fetch response is cancelled after timeout", async () => {
    vi.useFakeTimers();
    const { transport, fetcher } = setup(20);
    let resolveResponse!: (response: Response) => void;
    let cancelled = false;
    fetcher.mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
    const result = expect(transport.discovery(baseUrl)).rejects.toBeInstanceOf(OperatorTransportError);
    await vi.advanceTimersByTimeAsync(20);
    await result;
    resolveResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test.each(["/../probe", "//internal/probe", "/probe?target=internal", "/%70robe", "/.well-known/unidocs-operator"])("rejects unsafe configured probe path %s", path => {
    expect(() => createBoundOperatorTransport([{ baseUrl, probePath: path, service: { fetch: async () => Response.json({}) } }])).toThrow();
  });

  test("does not disclose upstream secrets in failures", async () => {
    const { transport, fetcher } = setup();
    fetcher.mockRejectedValue(new Error("upstream-secret"));
    await expect(transport.discovery(baseUrl)).rejects.toThrow("Operator request failed or target is not permitted");
  });
});