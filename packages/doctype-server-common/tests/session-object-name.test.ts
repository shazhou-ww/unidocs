import { describe, expect, test } from "vitest";
import {
  docSessionObjectName,
  docStorageIdentityKey,
} from "../src/session-object-name.js";

describe("docSessionObjectName", () => {
  test.each([
    ["a:b", "c", "a", "b:c"],
    ["雪", "session", "雪s", "ession"],
    ["tenant/one", "session:two", "tenant", "/one:session:two"],
  ])("does not collide for delimiter-containing IDs", (tenantA, sessionA, tenantB, sessionB) => {
    expect(docSessionObjectName(tenantA, sessionA))
      .not.toBe(docSessionObjectName(tenantB, sessionB));
  });

  test("uses UTF-8 byte lengths", () => {
    expect(docSessionObjectName("雪", "a:b")).toBe("v1:3:雪:3:a:b");
  });

  test("includes tenant, configured Doc type, and session without delimiter collisions", () => {
    expect(docStorageIdentityKey("a:b", "docx", "c"))
      .not.toBe(docStorageIdentityKey("a", "b:docx", "c"));
    expect(docStorageIdentityKey("雪", "docx", "a:b"))
      .toBe("v1:3:雪:4:docx:3:a:b");
  });
});