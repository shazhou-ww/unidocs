// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../src/ui/api.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

test("uses the CSRF token returned by the session endpoint for mutations", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf-from-session" },
    }))
    .mockResolvedValueOnce(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

  await api("/admin/me");
  await api("/admin/stacks", { method: "POST", body: "{}" });

  const mutationInit = fetchMock.mock.calls[1]?.[1];
  expect(new Headers(mutationInit?.headers).get("X-CSRF-Token")).toBe("csrf-from-session");
});