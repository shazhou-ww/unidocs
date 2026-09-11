import { describe, expect, it } from "vitest";
import { PlatformError, toPlatformError } from "../src/errors.js";

describe("toPlatformError", () => {
  it("保留 code、requestId 与 message", () => {
    const error = toPlatformError({
      error: {
        code: "version_conflict",
        message: "current version moved",
        requestId: "req-1",
      },
    });

    expect(error).toBeInstanceOf(PlatformError);
    expect(error.code).toBe("version_conflict");
    expect(error.requestId).toBe("req-1");
    expect(error.message).toBe("current version moved");
    expect(error.details).toBeNull();
  });

  it("保留 details", () => {
    const error = toPlatformError({
      error: { code: "invalid_request", message: "bad", requestId: "req-2", details: { field: "name" } },
    });

    expect(error.details).toEqual({ field: "name" });
  });

  it("未知 code 原样保留，不塌缩成 invalid_request", () => {
    const error = toPlatformError({
      error: { code: "some_future_code", message: "x", requestId: "req-3" },
    });

    expect(error.code).toBe("some_future_code");
  });
});
