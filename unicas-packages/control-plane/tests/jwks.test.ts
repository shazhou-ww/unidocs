import { buildStackJwks as serviceBuildStackJwks } from "@unicas/service";
import { describe, expect, test } from "vitest";
import { buildStackJwks } from "../src/index.js";

describe("control-plane JWKS compatibility", () => {
  test("re-exports the service helper", () => {
    expect(buildStackJwks).toBe(serviceBuildStackJwks);
  });
});
