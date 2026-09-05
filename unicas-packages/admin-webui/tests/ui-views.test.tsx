// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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
  test("shows the connect form when no OAuth issuer is configured", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "OAuth issuer is not configured" }, 404));
    render(<IssuerView stackId={STACK} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Inspect issuer" })).toBeInTheDocument());
    expect(screen.queryByText(/Status:/)).not.toBeInTheDocument();
  });

  test("shows status for an active OAuth issuer", async () => {
    fetchMock.mockResolvedValueOnce(json({
      stackId: STACK,
      issuer: "https://issuer.example/oauth",
      audience: `https://cas.example/stacks/${STACK}`,
      metadataUrl: "https://issuer.example/.well-known/oauth-authorization-server/oauth",
      metadataType: "oauth",
      authorizationEndpoint: "https://issuer.example/oauth/authorize",
      tokenEndpoint: "https://issuer.example/oauth/token",
      jwksUri: "https://issuer.example/oauth/jwks",
      registrationEndpoint: null,
      scopesSupported: ["cas:read"],
      codeChallengeMethodsSupported: ["S256"],
      status: "active",
      verifiedAt: 10,
      lastRefreshAt: 11,
      lastRefreshError: null,
      jwksDigest: "digest",
      capabilityMaxLifetimeSeconds: 1800,
      revision: 2,
    }));
    render(<IssuerView stackId={STACK} />);
    await waitFor(() => expect(screen.getByText(/Status:/)).toHaveTextContent("active"));
    expect(screen.getByRole("button", { name: "Issuer active" })).toBeDisabled();
    expect(screen.getByLabelText("Issuer")).toBeDisabled();
    expect(screen.getByRole("link", { name: "https://issuer.example/oauth/jwks" }))
      .toHaveAttribute("href", "https://issuer.example/oauth/jwks");
  });

  test("inspects and activates a standards-based OAuth issuer", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "NOT_FOUND", message: "OAuth issuer is not configured" }, 404))
      .mockResolvedValueOnce(json({
        inspectionId: "oinsp_1", stackId: STACK, issuer: "https://auth.example", audience: `https://cas.example/stacks/${STACK}`,
        metadataUrl: "https://auth.example/.well-known/oauth-authorization-server", metadataType: "oauth",
        authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: "https://auth.example/token",
        jwksUri: "https://auth.example/jwks", registrationEndpoint: null, scopesSupported: ["cas:read"],
        codeChallengeMethodsSupported: ["S256"], metadataDigest: "m", jwksDigest: "j",
        capabilityMaxLifetimeSeconds: 1800, challenge: "cas-oauth-issuer-inspection-v1\nchallenge",
        expiresAt: 1000, keys: [{ kid: "key-1", algorithm: "ES256", publicJwk: {} }], revision: 1,
      }))
      .mockResolvedValueOnce(json({ stackId: STACK, status: "active", revision: 2 }))
      .mockResolvedValueOnce(json({
        stackId: STACK,
        issuer: "https://auth.example",
        audience: `https://cas.example/stacks/${STACK}`,
        metadataUrl: "https://auth.example/.well-known/oauth-authorization-server",
        metadataType: "oauth",
        authorizationEndpoint: "https://auth.example/authorize",
        tokenEndpoint: "https://auth.example/token",
        jwksUri: "https://auth.example/jwks",
        registrationEndpoint: null,
        scopesSupported: ["cas:read"],
        codeChallengeMethodsSupported: ["S256"],
        status: "active",
        verifiedAt: 20,
        lastRefreshAt: 21,
        lastRefreshError: null,
        jwksDigest: "j",
        capabilityMaxLifetimeSeconds: 1800,
        revision: 2,
      }));
    const user = userEvent.setup();
    render(<IssuerView stackId={STACK} />);
    await user.type(await screen.findByLabelText("Issuer", { selector: "#oauth-issuer-url" }), "https://auth.example");
    await user.click(screen.getByRole("button", { name: "Inspect issuer" }));
    await screen.findByText(/cas-oauth-issuer-inspection-v1/);
    await user.type(screen.getByLabelText("Activation proof (compact JWS)"), "proof");
    await user.click(screen.getByRole("button", { name: "Verify and activate" }));
    await waitFor(() => expect(screen.getByText(/Status:/)).toHaveTextContent("active"));
    const inspectionCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/oauth-issuer/inspections"));
    expect(JSON.parse(inspectionCall![1]!.body as string)).toEqual({ issuer: "https://auth.example" });
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT" && String(call[0]).endsWith("/oauth-issuer"))).toBe(true);
  });
});

describe("ControlAuditView", () => {
  test("paginates audit events with load more", async () => {
    fetchMock
      .mockResolvedValueOnce(json({
        items: [
          { eventId: "evt_1", stackId: STACK, actor: { identityIssuer: "iss", subject: "alice" }, action: "stack.created", target: STACK, requestId: "r1", traceId: null, createdAt: 1 },
          { eventId: "evt_legacy", stackId: STACK, actor: { identityIssuer: "iss", subject: "alice" }, action: "issuer.put", target: STACK, requestId: "r0", traceId: null, createdAt: 0 },
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
    expect(screen.getByText("Legacy")).toHaveAttribute("title", "Historical action from the retired issuer-key API");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByText("member.invited")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});

describe("remaining read views", () => {
  test("Root Ref audit shows an empty catalog and usage remains unavailable", async () => {
    fetchMock.mockResolvedValueOnce(json({ domains: [] }));
    const first = render(<RootRefAuditView stackId={STACK} />);
    expect(await screen.findByText(/No Root Ref domains have been observed yet/)).toBeInTheDocument();
    first.unmount();
    render(<UsageView stackId={STACK} />);
    expect(screen.getByText(/Usage is a tenant-plane read/)).toBeInTheDocument();
  });
});
