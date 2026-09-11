import { expect, test } from "vitest";
import { serveBundleObject } from "../src/bundle-ingress.js";

const bundleId = `tb_${"a".repeat(64)}`;

function bucket(path: string, body: string, sha256 = "b".repeat(64)) {
  return {
    async get(key: string) {
      if (key !== path) return null;
      return { body: new Blob([body]).stream(), customMetadata: { sha256 } };
    },
  } as unknown as R2Bucket;
}

test("serves an immutable bundle object with a fixed safe MIME type", async () => {
  const key = `type-card-bundles/${bundleId}/icons/card.svg`;
  const response = await serveBundleObject(new Request(`https://bundles.unidocs.test/type-card-bundles/${bundleId}/icons/card.svg`), bucket(key, "<svg/>"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<svg/>");
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("etag")).toBe(`"sha256-${"b".repeat(64)}"`);
});

test("only exposes canonical Type Card JSON and validated image extensions", async () => {
  const store = bucket(`type-card-bundles/${bundleId}/index.html`, "<script/>");
  expect((await serveBundleObject(new Request(`https://bundles.unidocs.test/type-card-bundles/${bundleId}/index.html`), store)).status).toBe(404);
  expect((await serveBundleObject(new Request(`https://bundles.unidocs.test/type-card-bundles/${bundleId}/other.json`), store)).status).toBe(404);
  expect((await serveBundleObject(new Request(`https://bundles.unidocs.test/type-card-bundles/${bundleId}/..%2Fsecret.png`), store)).status).toBe(404);
});