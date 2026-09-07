// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MembersView,
  IssuerView,
  ControlAuditView,
  UsageView,
  PlaygroundView,
} from "../src/ui/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const STACK = "cas_stack_a";

function managedIssuer() {
  return {
    stackId: STACK,
    mode: "managed",
    issuer: `https://cas.example/managed-issuers/${STACK}`,
    audience: `https://cas.example/stacks/${STACK}`,
    metadataUrl: "https://cas.example/metadata",
    metadataType: "oauth",
    authorizationEndpoint: "https://cas.example/authorize",
    tokenEndpoint: "https://cas.example/token",
    jwksUri: "https://cas.example/jwks",
    registrationEndpoint: null,
    scopesSupported: ["cas:manage"],
    codeChallengeMethodsSupported: ["S256"],
    status: "active",
    verifiedAt: 1,
    lastRefreshAt: 1,
    lastRefreshError: null,
    jwksDigest: "digest",
    capabilityMaxLifetimeSeconds: 3600,
    revision: 1,
  };
}

describe("PlaygroundView", () => {
  test("creates a root from an inline editor on blur", async () => {
    fetchMock
      .mockResolvedValueOnce(json(managedIssuer()))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({
        accessToken: "tenant-token",
        tokenType: "Bearer",
        expiresIn: 3600,
        expiresAt: Date.now() + 3_600_000,
        issuer: `https://cas.example/managed-issuers/${STACK}`,
        audience: `https://cas.example/stacks/${STACK}`,
        tenantId: "member_abc",
        permissions: ["tenants:member_abc:cas:manage"],
      }))
      .mockResolvedValueOnce(json({ hash: "a".repeat(64), ready: true, leaseStartedAt: 1, leaseExpiresAt: 2 }))
      .mockResolvedValueOnce(json({ success: true, revision: 1 }))
      .mockResolvedValueOnce(json({ rootId: "root-1", name: "Project", manifestHash: "a".repeat(64), revision: 1, createdAt: 1, updatedAt: 1 }))
      .mockResolvedValueOnce(json({ metadata: { hash: "a".repeat(64), size: 7, contentType: "application/vnd.unicas.file-manifest+cbor;version=1", refs: [] } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([0xa2, 0x61, 0x65, 0x80, 0x61, 0x76, 0x01])))
      .mockResolvedValueOnce(json({ items: [{ rootId: "root-1", name: "Project", manifestHash: "a".repeat(64), revision: 1, createdAt: 1, updatedAt: 1 }] }));
    const user = userEvent.setup();
    render(<PlaygroundView stackId={STACK} />);

    await user.click(await screen.findByRole("button", { name: "Create root" }));
    const editor = screen.getByRole("textbox", { name: "New root name" });
    await user.type(editor, "Project");
    await user.tab();

    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "File roots" })).getByRole("button", { name: /Project/ })).toBeInTheDocument());
    const createCall = fetchMock.mock.calls.find(([path, init]) =>
      path === `/admin/stacks/${STACK}/playground/file-roots` && init?.method === "POST"
    );
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ name: "Project" });
  });

  test("rejects an invalid inline root name before issuing a capability", async () => {
    fetchMock
      .mockResolvedValueOnce(json(managedIssuer()))
      .mockResolvedValueOnce(json({ items: [] }));
    const user = userEvent.setup();
    render(<PlaygroundView stackId={STACK} />);

    await user.click(await screen.findByRole("button", { name: "Create root" }));
    await user.type(screen.getByRole("textbox", { name: "New root name" }), "   ");
    await user.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent("Root name is required");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("rejects a duplicate inline root name locally", async () => {
    fetchMock
      .mockResolvedValueOnce(json(managedIssuer()))
      .mockResolvedValueOnce(json({ items: [{ rootId: "root-1", name: "Project", manifestHash: "a".repeat(64), revision: 1, createdAt: 1, updatedAt: 1 }] }));
    const user = userEvent.setup();
    render(<PlaygroundView stackId={STACK} />);

    await user.click(await screen.findByRole("button", { name: "Create root" }));
    await user.type(screen.getByRole("textbox", { name: "New root name" }), "project");
    await user.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keeps the member capability private and reads tenant usage", async () => {
    fetchMock
      .mockResolvedValueOnce(json(managedIssuer()))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({
        accessToken: "tenant-token",
        tokenType: "Bearer",
        expiresIn: 3600,
        expiresAt: Date.now() + 3_600_000,
        issuer: `https://cas.example/managed-issuers/${STACK}`,
        audience: `https://cas.example/stacks/${STACK}`,
        tenantId: "member_abc",
        permissions: ["tenants:member_abc:cas:manage"],
      }))
      .mockResolvedValueOnce(json({ nodeCount: 0, readyContentBytes: 0, readyStoredBytes: 0, reservedBytes: 0, notReadyNodeCount: 0, leasedNodeCount: 0 }));
    const user = userEvent.setup();
    render(<PlaygroundView stackId={STACK} />);

    expect(await screen.findByRole("button", { name: /Usage/ })).toBeInTheDocument();
    expect(screen.getByText("File roots")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run garbage collection" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(screen.getByText("Nodes").nextSibling).toHaveTextContent("0"));
    expect(screen.getByText("member_abc")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("tenant-token")).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenNthCalledWith(3,
      `/admin/stacks/${STACK}/managed-capabilities`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(4,
      `https://cas.example/stacks/${STACK}/tenants/member_abc/cas/usage`,
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect((fetchMock.mock.calls[3][1]?.headers as Headers).get("Authorization")).toBe("Bearer tenant-token");
  });

  test.each([false, true])("refreshes usage after GC and preserves its result if the refresh fails (%s)", async (refreshFails) => {
    const before = { nodeCount: 3, readyContentBytes: 2048, readyStoredBytes: 3072, reservedBytes: 0, notReadyNodeCount: 0, leasedNodeCount: 0 };
    const after = { ...before, nodeCount: 1, readyContentBytes: 1024, readyStoredBytes: 1536 };
    fetchMock
      .mockResolvedValueOnce(json(managedIssuer()))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({
        accessToken: "tenant-token", tokenType: "Bearer", expiresIn: 3600,
        expiresAt: Date.now() + 3_600_000,
        issuer: `https://cas.example/managed-issuers/${STACK}`,
        audience: `https://cas.example/stacks/${STACK}`, tenantId: "member_abc",
        permissions: ["tenants:member_abc:cas:manage"],
      }))
      .mockResolvedValueOnce(json(before))
      .mockResolvedValueOnce(json({ examined: 3, deleted: 2, reclaimedContentBytes: 1024 }))
      .mockResolvedValueOnce(refreshFails ? json({ error: "UNAVAILABLE", message: "Usage temporarily unavailable" }, 503) : json(after));
    const user = userEvent.setup();
    render(<PlaygroundView stackId={STACK} />);
    await user.click(await screen.findByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(screen.getByText("Nodes").nextSibling).toHaveTextContent("3"));
    const confirmation = screen.getByRole("checkbox", { name: /I understand/ });
    await user.click(confirmation);
    await user.click(screen.getByRole("button", { name: "Run garbage collection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh usage" })).toBeEnabled());
    expect(fetchMock.mock.calls.slice(4).map(([path]) => path)).toEqual([
      `https://cas.example/stacks/${STACK}/tenants/member_abc/cas/gc`,
      `https://cas.example/stacks/${STACK}/tenants/member_abc/cas/usage`,
    ]);
    expect(screen.getByText(/Examined 3, deleted 2/)).toBeInTheDocument();
    expect(confirmation).not.toBeChecked();
    expect(screen.getByText("Nodes").nextSibling).toHaveTextContent(refreshFails ? "3" : "1");
    expect(screen.getByText("Content").nextSibling).toHaveTextContent(refreshFails ? "2.00 KiB" : "1.00 KiB");
    if (refreshFails) expect(screen.getByRole("alert")).toHaveTextContent("Usage temporarily unavailable");
  });

  test("renews a capability only when a request finds it expired", async () => {
    const now = Date.now();
    const capability = (accessToken: string) => ({
      accessToken,
      tokenType: "Bearer",
      expiresIn: 1,
      expiresAt: now + (accessToken === "tenant-token-1" ? 1000 : 10_000),
      issuer: `https://cas.example/managed-issuers/${STACK}`,
      audience: `https://cas.example/stacks/${STACK}`,
      tenantId: "member_abc",
      permissions: ["tenants:member_abc:cas:manage"],
    });
    fetchMock
      .mockResolvedValueOnce(json(managedIssuer()))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json(capability("tenant-token-1")))
      .mockResolvedValueOnce(json({ nodeCount: 1, readyContentBytes: 0, readyStoredBytes: 0, reservedBytes: 0, notReadyNodeCount: 0, leasedNodeCount: 0 }))
      .mockResolvedValueOnce(json(capability("tenant-token-2")))
      .mockResolvedValueOnce(json({ nodeCount: 2, readyContentBytes: 0, readyStoredBytes: 0, reservedBytes: 0, notReadyNodeCount: 0, leasedNodeCount: 0 }));
    const user = userEvent.setup();
    render(<PlaygroundView stackId={STACK} />);

    await user.click(await screen.findByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(screen.getByText("Nodes").nextSibling).toHaveTextContent("1"));
    vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    await user.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(screen.getByText("Nodes").nextSibling).toHaveTextContent("2"));

    const issueCalls = fetchMock.mock.calls.filter(([path]) =>
      path === `/admin/stacks/${STACK}/managed-capabilities`
    );
    expect(issueCalls).toHaveLength(2);
    expect((fetchMock.mock.calls[5][1]?.headers as Headers).get("Authorization")).toBe("Bearer tenant-token-2");
  });
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  document.head.innerHTML = '<meta name="x-csrf-token" content="csrf-1" />';
});

afterEach(() => {
  vi.restoreAllMocks();
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
  test("copies the managed issuer URL from a non-editable text block with keyboard support", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    fetchMock.mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json(managedIssuer()));
    render(<IssuerView stackId={STACK} />);
    const copy = await screen.findByRole("button", { name: "Copy managed issuer URL" });
    expect(screen.queryByRole("textbox", { name: "Managed issuer URL" })).not.toBeInTheDocument();
    expect(copy).toHaveTextContent(managedIssuer().issuer);
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith(managedIssuer().issuer);
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    await user.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("reports clipboard failures without changing the issuer", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    fetchMock.mockResolvedValueOnce(json(null)).mockResolvedValueOnce(json(managedIssuer()));
    render(<IssuerView stackId={STACK} />);
    await user.click(await screen.findByRole("button", { name: "Copy managed issuer URL" }));
    expect(screen.getByRole("status")).toHaveTextContent("Could not copy URL");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("shows the connect form when no OAuth issuer is configured", async () => {
    fetchMock
      .mockResolvedValueOnce(json(null))
      .mockResolvedValueOnce(json(managedIssuer()));
    render(<IssuerView stackId={STACK} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Inspect issuer" })).toBeInTheDocument());
    const customCard = screen.getByRole("heading", { name: "Custom OAuth authorization server" }).closest(".card")!;
    expect(within(customCard).queryByText(/Status:/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe(`/admin/stacks/${STACK}/oauth-issuer?optional=true`);
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
    })).mockResolvedValueOnce(json(managedIssuer()));
    render(<IssuerView stackId={STACK} />);
    const customCard = screen.getByRole("heading", { name: "Custom OAuth authorization server" }).closest(".card")!;
    await waitFor(() => expect(within(customCard).getByText(/Status:/)).toHaveTextContent("active"));
    expect(screen.getByRole("button", { name: "Issuer active" })).toBeDisabled();
    expect(screen.getByLabelText("Issuer")).toBeDisabled();
    expect(screen.getByRole("link", { name: "https://issuer.example/oauth/jwks" }))
      .toHaveAttribute("href", "https://issuer.example/oauth/jwks");
  });

  test("inspects and activates a standards-based OAuth issuer", async () => {
    fetchMock
      .mockResolvedValueOnce(json(null))
      .mockResolvedValueOnce(json(managedIssuer()))
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
      }))
      .mockResolvedValueOnce(json(managedIssuer()));
    const user = userEvent.setup();
    render(<IssuerView stackId={STACK} />);
    await user.type(await screen.findByLabelText("Issuer", { selector: "#oauth-issuer-url" }), "https://auth.example");
    await user.click(screen.getByRole("button", { name: "Inspect issuer" }));
    await screen.findByText(/cas-oauth-issuer-inspection-v1/);
    await user.type(screen.getByLabelText("Activation proof (compact JWS)"), "proof");
    await user.click(screen.getByRole("button", { name: "Verify and activate" }));
    const customCard = screen.getByRole("heading", { name: "Custom OAuth authorization server" }).closest(".card")!;
    await waitFor(() => expect(within(customCard).getByText(/Status:/)).toHaveTextContent("active"));
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

describe("UsageView", () => {
  test("documents the delegated tenant-plane read", () => {
    render(<UsageView stackId={STACK} />);
    expect(screen.getByText(/Usage is a tenant-plane read/)).toBeInTheDocument();
  });
});
