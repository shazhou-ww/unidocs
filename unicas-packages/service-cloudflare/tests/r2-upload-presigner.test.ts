import { describe, expect, test } from "vitest";
import {
  CanonicalUploadContentType,
  R2UploadPresigner,
} from "../src/r2-upload-presigner.js";

const presigner = () => new R2UploadPresigner({
  accountId: "account-id",
  bucketName: "cas-bucket",
  accessKeyId: "access-key-id",
  secretAccessKey: "secret-access-key",
  expiresInSeconds: 300,
});

describe("R2UploadPresigner", () => {
  test("signs a write-once, fixed-length canonical PUT", async () => {
    const upload = await presigner().signPut("_uploads/v1/a b", 560);
    const url = new URL(upload.url);

    expect(upload.method).toBe("PUT");
    expect(url.origin).toBe("https://account-id.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/cas-bucket/_uploads/v1/a%20b");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;if-none-match",
    );
    expect(upload.headers).toEqual({
      "Content-Length": "560",
      "Content-Type": CanonicalUploadContentType,
      "If-None-Match": "*",
    });
    expect(upload.url).not.toContain("secret-access-key");
  });

  test("rejects invalid expiry, keys, and lengths", async () => {
    expect(() => new R2UploadPresigner({
      accountId: "account-id",
      bucketName: "cas-bucket",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
      expiresInSeconds: 0,
    })).toThrow("expiry");
    await expect(presigner().signPut("_uploads//bad", 10)).rejects.toThrow("key segment");
    await expect(presigner().signPut("_uploads/good", 0)).rejects.toThrow("content length");
  });
});