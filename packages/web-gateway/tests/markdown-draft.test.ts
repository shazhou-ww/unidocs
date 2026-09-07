import { beforeEach, expect, it, vi } from "vitest";
import { markdownDraftKey, readMarkdownDraft, writeMarkdownDraft, removeMarkdownDraft, MAX_MARKDOWN_DRAFT_LENGTH } from "../src/ui/markdown-draft.js";
import { clearSession, loadSession } from "../src/ui/oauth.js";
import { accessTokenSession } from "./session-fixture.js";

beforeEach(() => { sessionStorage.clear(); accessTokenSession("alice"); });
const draft = { content: "# Draft", baseContent: "# Cloud", baseVersion: 12 };

it("partitions by issuer, subject, tenant, type and document without storing tokens", () => {
  const session = loadSession()!;
  const key = markdownDraftKey(session, "markdown", "one");
  writeMarkdownDraft(key, { ...draft, accessToken: "do-not-store" } as typeof draft);
  expect(readMarkdownDraft(key)).toEqual(draft);
  for (const claims of [{ iss: "other", sub: "user" }, { iss: "issuer", sub: "other" }]) {
    const other = { ...session, accessToken: `header.${btoa(JSON.stringify(claims))}.signature` };
    expect(readMarkdownDraft(markdownDraftKey(other, "markdown", "one"))).toBeNull();
  }
  expect(readMarkdownDraft(markdownDraftKey({ ...session, tenantId: "bob" }, "markdown", "one"))).toBeNull();
  expect(readMarkdownDraft(markdownDraftKey(session, "psd", "one"))).toBeNull();
  expect(readMarkdownDraft(markdownDraftKey(session, "markdown", "two"))).toBeNull();
  expect(markdownDraftKey({ ...session, accessToken: session.accessToken.replace(".signature", ".rotated") }, "markdown", "one")).toBe(key);
  expect(sessionStorage.getItem(key!)).not.toMatch(/accessToken|do-not-store|refreshToken/);
  expect(key).not.toContain(session.accessToken);
});

it("discards one draft and clears all cloud drafts on sign-out without touching public samples", () => {
  const session = loadSession()!;
  const first = markdownDraftKey(session, "markdown", "one");
  const second = markdownDraftKey(session, "markdown", "two");
  writeMarkdownDraft(first, draft); writeMarkdownDraft(second, draft);
  sessionStorage.setItem("public-local-sample", "untouched");
  removeMarkdownDraft(first);
  expect(readMarkdownDraft(first)).toBeNull();
  expect(readMarkdownDraft(second)).toEqual(draft);
  clearSession();
  expect(readMarkdownDraft(second)).toBeNull();
  expect(loadSession()).toBeNull();
  expect(sessionStorage.getItem("public-local-sample")).toBe("untouched");
});

it("rejects corrupted records, unavailable identity, oversize content and storage failures", () => {
  const key = markdownDraftKey(loadSession()!, "markdown", "one");
  for (const raw of ["broken", "null", JSON.stringify({ schema: 2, ...draft }), JSON.stringify({ schema: 1, ...draft, baseVersion: 0 })]) {
    sessionStorage.setItem(key!, raw);
    expect(() => readMarkdownDraft(key)).toThrow();
    expect(sessionStorage.getItem(key!)).toBe(raw);
  }
  expect(() => writeMarkdownDraft(null, draft)).toThrow();
  expect(() => writeMarkdownDraft(key, { ...draft, content: "x".repeat(MAX_MARKDOWN_DRAFT_LENGTH) })).toThrow();
  const storage = { setItem: vi.fn(() => { throw new Error("quota"); }) } as unknown as Storage;
  expect(() => writeMarkdownDraft(key, draft, storage)).toThrow("quota");
});