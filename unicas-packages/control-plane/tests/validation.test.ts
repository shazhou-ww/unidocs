import {
  decodeControlListCursor as serviceDecodeControlListCursor,
  validateDisplayName as serviceValidateDisplayName,
} from "@unicas/service";
import { describe, expect, test } from "vitest";
import {
  decodeControlListCursor,
  validateDisplayName,
} from "../src/index.js";

describe("control-plane validation compatibility", () => {
  test("re-exports service validation and cursor helpers", () => {
    expect(validateDisplayName).toBe(serviceValidateDisplayName);
    expect(decodeControlListCursor).toBe(serviceDecodeControlListCursor);
  });
});
