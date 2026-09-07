import { beforeEach, expect, it, vi } from "vitest";
import { CREATION_TRACKING_KEY, creationTrackingScope, readCreationTracking, writeCreationTracking } from "../src/ui/creation-tracking.js";
import { clearSession, loadSession } from "../src/ui/oauth.js";
import { accessTokenSession } from "./session-fixture.js";

beforeEach(() => { sessionStorage.clear(); accessTokenSession("alice"); });

it("restores only document locators for the same principal and tenant", () => {
  const session = loadSession()!;
  const scope = creationTrackingScope(session);
  const item = { docType: "markdown", docId: "pending", accessToken: "must-not-be-stored", file: "private" };
  writeCreationTracking(scope, [item, item]);
  expect(readCreationTracking(scope)).toEqual([{ docType: "markdown", docId: "pending" }]);
  expect(readCreationTracking(creationTrackingScope({ ...session, tenantId: "bob" }))).toEqual([]);
  const otherToken = `${btoa('{}')}.${btoa(JSON.stringify({ iss: "issuer", sub: "another-user" }))}.signature`;
  expect(readCreationTracking(creationTrackingScope({ ...session, accessToken: otherToken }))).toEqual([]);
  const raw = sessionStorage.getItem(CREATION_TRACKING_KEY)!;
  expect(raw).not.toContain("accessToken"); expect(raw).not.toContain("private"); expect(raw).not.toContain(session.accessToken);
});

it("removes terminal tasks on the next write and clears tracking on sign-out", () => {
  const scope = creationTrackingScope(loadSession()!);
  writeCreationTracking(scope, [{ docType: "psd", docId: "pending" }]);
  writeCreationTracking(scope, []);
  expect(readCreationTracking(scope)).toEqual([]);
  writeCreationTracking(scope, [{ docType: "psd", docId: "pending" }]);
  clearSession();
  expect(sessionStorage.getItem(CREATION_TRACKING_KEY)).toBeNull();
});

it("does not silently replace invalid data or swallow storage failures", () => {
  const scope = creationTrackingScope(loadSession()!);
  sessionStorage.setItem(CREATION_TRACKING_KEY, "broken");
  expect(() => readCreationTracking(scope)).toThrow();
  expect(sessionStorage.getItem(CREATION_TRACKING_KEY)).toBe("broken");
  expect(() => writeCreationTracking(null, [])).toThrow("登录身份");
  const storage = { setItem: vi.fn(() => { throw new Error("quota"); }) } as unknown as Storage;
  expect(() => writeCreationTracking(scope, [], storage)).toThrow("quota");
});