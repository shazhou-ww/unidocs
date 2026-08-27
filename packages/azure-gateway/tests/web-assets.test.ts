/**
 * UI 与 API 的路由优先级。
 *
 * 这层网要挡的是 SPA 回退把 API 吃掉:一旦 `/tenants/*` 也走回退,一个拼错
 * 的 API 路径会返回 200 + HTML 而不是 404,调用方拿到一段 `<!doctype html>`
 * 去 JSON.parse,错误现场离真正的原因隔着好几层。
 */
import { describe, expect, it } from "vitest";
import { contentTypeFor, webAssetResponse } from "../src/web-assets.js";
import { WEB_ASSETS } from "../src/web-assets.generated.js";

const bundled = Object.keys(WEB_ASSETS).length > 0;

function get(path: string, method = "GET"): Response | null {
  return webAssetResponse(new Request(`https://gw${path}`, { method }));
}

describe("gateway UI routing", () => {
  it.runIf(bundled)("serves index.html at the root", () => {
    const res = get("/");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it.runIf(bundled)("falls back to index.html for unknown UI paths", () => {
    expect(get("/some/client/route")?.status).toBe(200);
  });

  it.runIf(bundled)("never shadows the API namespace", () => {
    // 这两条是本文件存在的理由。
    expect(get("/tenants/u1/docs/psd/")).toBeNull();
    expect(get("/tenants")).toBeNull();
  });

  it.runIf(bundled)("does not fall back for a missing hashed asset", () => {
    // /assets 下是内容哈希文件名,miss 就是真 404,不是客户端路由。
    expect(get("/assets/does-not-exist.js")).toBeNull();
  });

  it.runIf(bundled)("leaves non-GET requests to the API handler", () => {
    expect(get("/", "POST")).toBeNull();
  });

  it.runIf(bundled)("pins hashed assets but never index.html", () => {
    const hashed = Object.keys(WEB_ASSETS).find(p => p.startsWith("/assets/"))!;
    expect(get(hashed)?.headers.get("Cache-Control")).toContain("immutable");
    expect(get("/")?.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("maps the content types web-psd actually ships", () => {
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/assets/index-abc.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/sample.psd")).toBe("image/vnd.adobe.photoshop");
    expect(contentTypeFor("/whatever.bin")).toBe("application/octet-stream");
  });

  it("returns null for every path when no UI is bundled", () => {
    // 存根状态下网关必须仍然是一个可用的纯 API 服务。
    if (bundled) return;
    expect(get("/")).toBeNull();
    expect(get("/tenants/u1/docs/psd/")).toBeNull();
  });
});
