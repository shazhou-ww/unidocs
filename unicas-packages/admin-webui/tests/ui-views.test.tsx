// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MembersView,
  IssuerView,
  ControlAuditView,
  RootRefAuditView,
  UsageView,
} from "../src/ui/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const STACK = "cas_stack_a";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  document.head.innerHTML = '<meta name="x-csrf-token" content="csrf-1" />';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MembersView", () => {
  test("lists members and creates an invitation with a copyable URL", async () => {
    fetchMock
      .mockResolvedValueOnce(json({
        items: [
          { stackId: STACK, identityIssuer: "iss", subject: "alice", displayName: "Alice", emailForDisplay: "alice@example.com" },
        ]
      }))
      .mockResolvedValueOnce(json({
        invitation: { invitationId: "inv_1", stackId: STACK, status: "pending", emailConstraint: null, expiresAt: 2000000000000, createdAt: 1, revision: 1 },
        acceptUrl: "https://cas.example/admin/invitations/token-xyz",
      }));
    const user = userEvent.setup();
    render(<MembersView stackId={STACK} stackRevision={1} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(screen.getByText(/Share this URL once/)).toBeInTheDocument());
    expect(screen.getByText("https://cas.example/admin/invitations/token-xyz")).toBeInTheDocument();
  });

  test("removing a member sends the stack revision as If-Match", async () => {
    fetchMock
      .mockResolvedValueOnce(json({
        items: [
          { stackId: STACK, identityIssuer: "iss", subject: "alice", displayName: null, emailForDisplay: null },
        ]
      }))
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ items: [] }));
    const user = userEvent.setup();
    render(<MembersView stackId={STACK} stackRevision={3} onChanged={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("No members.")).toBeInTheDocument());
    const deleteCall = fetchMock.mock.calls.find((call) => call[1]?.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(new Headers(deleteCall![1]!.headers).get("If-Match")).toBe('"3"');
  });
});

describe("IssuerView", () => {
  test("configures the issuer and lists keys", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "OAuth issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ stackId: STACK, issuer: "https://issuer.example", audience: "unidocs-cas", status: "active", revision: 1 }))
      .mockResolvedValueOnce(json({
        keys: [
          { stackId: STACK, kid: "k1", algorithm: "ES256", publicJwk: { kty: "EC" }, state: "active", revision: 1 },
        ]
      }));
    render(<IssuerView stackId={STACK} />);
    await waitFor(() => expect(screen.getByDisplayValue("https://issuer.example")).toBeInTheDocument());
    expect(screen.getByText("k1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire" })).toBeInTheDocument();
  });

  test("requests a possession challenge and submits the signed proof", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "OAuth issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ keys: [] }))
      .mockResolvedValueOnce(json({ nonce: "nonce-123" }))
      .mockResolvedValueOnce(json({ stackId: STACK, kid: "k1", algorithm: "ES256", publicJwk: {}, state: "active", revision: 1 }))
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "OAuth issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ keys: [{ stackId: STACK, kid: "k1", algorithm: "ES256", publicJwk: {}, state: "active", revision: 1 }] }));
    const user = userEvent.setup();
    render(<IssuerView stackId={STACK} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Request possession challenge" })).toBeInTheDocument());
    await user.type(screen.getByLabelText("kid"), "k1");
    await user.click(screen.getByRole("button", { name: "Request possession challenge" }));
    await waitFor(() => expect(screen.getByText(/cas-possession-v1/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Public JWK"), { target: { value: '{"kty":"EC"}' } });
    fireEvent.change(screen.getByLabelText("Possession proof (compact JWS)"), { target: { value: "eyJhbGciOiJFUzI1NiJ9.sig" } });
    await user.click(screen.getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(screen.getByText("k1")).toBeInTheDocument());
    const addCall = fetchMock.mock.calls.find((call) => call[0]?.includes("/issuer/keys") && call[1]?.method === "POST");
    expect(addCall).toBeDefined();
    expect(JSON.parse(addCall![1]!.body as string)).toMatchObject({ kid: "k1", algorithm: "ES256" });
  });

  test("inspects and activates a standards-based OAuth issuer", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "OAuth issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ keys: [] }))
      .mockResolvedValueOnce(json({
        inspectionId: "oinsp_1", stackId: STACK, issuer: "https://auth.example", audience: "cas",
        metadataUrl: "https://auth.example/.well-known/oauth-authorization-server", metadataType: "oauth",
        authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: "https://auth.example/token",
        jwksUri: "https://auth.example/jwks", registrationEndpoint: null, scopesSupported: ["cas:read"],
        codeChallengeMethodsSupported: ["S256"], metadataDigest: "m", jwksDigest: "j",
        capabilityMaxLifetimeSeconds: 28800, challenge: "cas-oauth-issuer-inspection-v1\nchallenge",
        expiresAt: 1000, keys: [{ kid: "key-1", algorithm: "ES256", publicJwk: {} }], revision: 1,
      }))
      .mockResolvedValueOnce(json({ status: "active", revision: 2 }))
      .mockResolvedValueOnce(json({ issuer: "https://auth.example", audience: "cas", status: "active", revision: 2 }))
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({ keys: [] }));
    const user = userEvent.setup();
    render(<IssuerView stackId={STACK} />);
    await user.type(await screen.findByLabelText("Issuer", { selector: "#oauth-issuer-url" }), "https://auth.example");
    await user.type(screen.getByLabelText("Audience", { selector: "#oauth-issuer-audience" }), "cas");
    await user.click(screen.getByRole("button", { name: "Inspect issuer" }));
    await screen.findByText(/cas-oauth-issuer-inspection-v1/);
    await user.type(screen.getByLabelText("Activation proof (compact JWS)"), "proof");
    await user.click(screen.getByRole("button", { name: "Verify and activate" }));
    await waitFor(() => expect(screen.getByText(/Status:/)).toHaveTextContent("active"));
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT" && String(call[0]).endsWith("/oauth-issuer"))).toBe(true);
  });
});

describe("ControlAuditView", () => {
  test("paginates audit events with load more", async () => {
    fetchMock
      .mockResolvedValueOnce(json({
        items: [
          { eventId: "evt_1", stackId: STACK, actor: { identityIssuer: "iss", subject: "alice" }, action: "stack.created", target: STACK, requestId: "r1", traceId: null, createdAt: 1 },
        ], nextCursor: "cursor-2"
      }))
      .mockResolvedValueOnce(json({
        items: [
          { eventId: "evt_2", stackId: STACK, actor: { identityIssuer: "iss", subject: "bob" }, action: "member.invited", target: "inv_1", requestId: "r2", traceId: null, createdAt: 2 },
        ], nextCursor: null
      }));
    const user = userEvent.setup();
    render(<ControlAuditView stackId={STACK} />);
    await waitFor(() => expect(screen.getByText("stack.created")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("member.invited")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});

describe("placeholder views", () => {
  test("Root Ref audit and usage show documented not-available states", () => {
    const first = render(<RootRefAuditView stackId={STACK} />);
    expect(screen.getByText(/Audit data is not available yet/)).toBeInTheDocument();
    first.unmount();
    render(<UsageView stackId={STACK} />);
    expect(screen.getByText(/Usage is a tenant-plane read/)).toBeInTheDocument();
  });
});
