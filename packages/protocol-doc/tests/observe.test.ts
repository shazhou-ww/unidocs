import { describe, expect, it } from "vitest";
import {
  httpCallEvent,
  httpCallFailure,
  ObservedBodyCap,
  pickObservedHeaders,
  readObservedBody,
  truncateObservedBody,
} from "../src/observe.js";
import type { HttpCallInput } from "../src/observe.js";

const input: HttpCallInput = {
  dir: "out",
  target: "cas",
  op: "lease",
  method: "POST",
  durationMs: 42,
  tenantId: "u1",
  url: "https://cas.example/stacks/s/tenants/u1/cas/nodes/abc/lease",
  requestHeaders: { "content-type": "application/octet-stream" },
};

describe("请求头白名单", () => {
  it("放行白名单里的头", () => {
    const headers = new Headers({ "content-type": "application/json", accept: "*/*" });
    expect(pickObservedHeaders(headers)).toEqual({
      "content-type": "application/json",
      accept: "*/*",
    });
  });

  // 白名单而非黑名单,正是为了这条:这些头携带能力票/令牌,任何时候都不能进日志。
  it("丢掉每一个凭据头", () => {
    const headers = new Headers({
      Authorization: "Bearer secret-capability",
      "X-UniDocs-CAS-Capability": "delegated-secret",
      "X-Internal-Token": "internal-secret",
      Cookie: "session=secret",
      "content-type": "application/json",
    });
    const picked = pickObservedHeaders(headers);
    expect(picked).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(picked)).not.toContain("secret");
  });

  it("缺失的头不出现在结果里,而不是记成 undefined", () => {
    expect(pickObservedHeaders(new Headers())).toEqual({});
  });
});

describe("事件详略分级", () => {
  it("2xx 只记简报,不带 url / 头 / 响应体", () => {
    const event = httpCallEvent(input, 200);
    expect(event).toEqual({
      event: "http_call",
      dir: "out",
      target: "cas",
      op: "lease",
      method: "POST",
      status: 200,
      durationMs: 42,
      ok: true,
      tenantId: "u1",
    });
    expect(event.url).toBeUndefined();
    expect(event.requestHeaders).toBeUndefined();
  });

  it("4xx / 5xx 带上 url、请求头与响应体", () => {
    const event = httpCallEvent(input, 400, { responseBody: '{"error":"bad hash"}' });
    expect(event.ok).toBe(false);
    expect(event.status).toBe(400);
    expect(event.url).toBe(input.url);
    expect(event.requestHeaders).toEqual(input.requestHeaders);
    expect(event.responseBody).toBe('{"error":"bad hash"}');
  });

  // 没拿到响应和"拿到一个 5xx"是两件事:前者是超时/连接断,浏览器侧表现为
  // Failed to fetch。用 status 0 把它们分开,否则合成的 502 会掩盖真相。
  it("拿不到响应时 status 记 0 并带异常信息", () => {
    const event = httpCallFailure(input, new TypeError("fetch failed"));
    expect(event.status).toBe(0);
    expect(event.ok).toBe(false);
    expect(event.error).toBe("TypeError: fetch failed");
  });

  it("非 Error 的抛出物也能记下来", () => {
    expect(httpCallFailure(input, "boom").error).toBe("boom");
  });
});

describe("响应体截断", () => {
  it("短的原样保留", () => {
    expect(truncateObservedBody("short")).toEqual({ body: "short", truncated: false });
  });

  it("超长的截断并标记", () => {
    const result = truncateObservedBody("x".repeat(ObservedBodyCap + 100));
    expect(result.body).toHaveLength(ObservedBodyCap);
    expect(result.truncated).toBe(true);
  });

  it("从克隆的响应里读,原响应不受影响", async () => {
    const response = new Response('{"error":"nope"}', { status: 400 });
    const detail = await readObservedBody(response.clone());
    expect(detail.responseBody).toBe('{"error":"nope"}');
    // 原响应仍可被调用方正常消费 —— 这正是必须传克隆的原因。
    await expect(response.text()).resolves.toBe('{"error":"nope"}');
  });

  it("空响应体不产生 responseBody 字段", async () => {
    expect(await readObservedBody(new Response(null, { status: 500 }))).toEqual({});
  });

  it("读取失败不抛,日志不该把主流程带崩", async () => {
    const consumed = new Response("body", { status: 500 });
    await consumed.text();
    expect(await readObservedBody(consumed)).toEqual({});
  });
});
