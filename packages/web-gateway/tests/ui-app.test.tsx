import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../src/ui/app.js";
import { accessTokenSession } from "./session-fixture.js";

vi.mock("../src/ui/config.js", () => ({
  API_PREFIX: "",
  GATEWAY_ORIGIN: "http://127.0.0.1:8787",
  DEFAULT_DOC_TYPES: ["docx", "markdown"],
  CLIENT_NAME: "unidocs-gateway-webui",
  REDIRECT_PATH: "/ui/callback",
  REDIRECT_URI: "http://127.0.0.1:8787/ui/callback",
  OAUTH_BASE: "http://127.0.0.1:8787/oauth/unidocs-cloudflare",
  API_BASE: "http://127.0.0.1:8787",
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/ui/");
  window.location.hash = "/documents";
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gateway webui app", () => {
  test("shows the Google sign-in screen when not authenticated", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "UniDocs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/tenant/i)).not.toBeInTheDocument();
  });

  test("signs in by redirecting to the gateway authorize endpoint without a tenant", async () => {
    const user = userEvent.setup();
    const assigned: string[] = [];
    const originalLocation = window.location;
    // jsdom's window.location.assign is not configurable, so replace the
    // whole location object with a fake that captures the redirect.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        assign: (url: string) => void assigned.push(String(url)),
        replace: () => undefined,
        reload: () => undefined,
        hash: originalLocation.hash,
        href: originalLocation.href,
        origin: originalLocation.origin,
        pathname: originalLocation.pathname,
        search: originalLocation.search,
        toString: () => originalLocation.href,
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:8787/oauth/unidocs-cloudflare/register") {
        return Response.json({ client_id: "client-1" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));

    const authorize = assigned.find((url) => url.includes("/authorize"));
    expect(authorize).toBeTruthy();
    const url = new URL(authorize!);
    expect(url.pathname).toBe("/oauth/unidocs-cloudflare/authorize");
    // No client-supplied tenant: the gateway derives it from the account.
    expect(url.searchParams.has("tenant_id")).toBe(false);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  test("shows the document list for the session tenant after login", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenants/alice/docs/docx/") || url.includes("/tenants/alice/docs/markdown/")) {
        return Response.json({ success: true, data: [], count: 0 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    accessTokenSession("alice");
    window.location.hash = "/documents";
    render(<App />);
    expect(await screen.findByText(/tenant: alice/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "docx" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "markdown" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New document" })).toHaveLength(2);
  });

  test("guards preview links behind sign-in", () => {
    window.location.hash = "/preview/markdown/doc";
    render(<App />);
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  test("sign out removes stored credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ success: true, data: [], count: 0 })));
    accessTokenSession("alice");
    render(<App />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(sessionStorage.getItem("unidocs.oauth.session")).toBeNull();
  });
});
