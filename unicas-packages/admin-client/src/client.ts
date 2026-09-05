/**
 * `createAdminClient` — typed HTTP transport for the `/admin` control-plane
 * API (the BFF surface). One plain function per operation, paths built from
 * `casAdminRoutes`, request/response types straight from `@unicas/admin-protocol`
 * (the frozen contract — no tool-mirror duplication).
 *
 * The session provider yields the BFF session cookie + CSRF token; mutations
 * send `If-Match` (ETag preconditions) and `Idempotency-Key` where the
 * contract allows. Non-2xx responses surface as `AdminClientError`.
 */

import {
  casAdminRoutes,
  CasAdminETagHeader,
  CasAdminIdempotencyKeyHeader,
  CasAdminIfMatchHeader,
  CasAdminErrorCodes,
} from "@unicas/admin-protocol";
import type {
  CasAdminCreateHeaders,
  CasAdminMutationPreconditions,
  CasAdminPage,
  CasAdminPageQuery,
} from "@unicas/admin-protocol";
import type {
  CasControlAuditEvent,
  CasMemberInvitation,
  CasOperatorIdentity,
  CasOperatorIdentityKey,
  CasOAuthIssuerInspection,
  CasRefDomain,
  CasRootRefBalance,
  CasRootRefEvent,
  CasStack,
  CasStackId,
  CasStackMember,
  CasStackOAuthIssuer,
  CasManagedCapability,
} from "@unicas/admin-protocol";
import { AdminClientError } from "./errors.js";
import type {
  AdminClientConfig,
  AdminClientRead,
  AdminClientSession,
  AdminHttpFetcher,
} from "./types.js";

export interface AdminClient {
  me(): Promise<{ readonly identity: CasOperatorIdentity; readonly memberships: readonly CasStackMember[] }>;
  listStacks(query?: CasAdminPageQuery): Promise<CasAdminPage<CasStack>>;
  createStack(
    body: { readonly displayName: string },
    headers?: CasAdminCreateHeaders,
  ): Promise<CasStack>;
  getStack(path: { readonly stackId: CasStackId }): Promise<AdminClientRead<CasStack>>;
  patchStack(
    path: { readonly stackId: CasStackId },
    body: { readonly displayName?: string; readonly description?: string },
    ifMatch: string,
  ): Promise<AdminClientRead<CasStack>>;
  listMembers(
    path: { readonly stackId: CasStackId },
    query?: CasAdminPageQuery,
  ): Promise<CasAdminPage<CasStackMember>>;
  deleteMember(
    path: { readonly stackId: CasStackId },
    query: CasOperatorIdentityKey,
    ifMatch: string,
  ): Promise<{ readonly ok: true }>;
  createMemberInvitation(
    path: { readonly stackId: CasStackId },
    body: { readonly emailConstraint?: string },
    headers?: CasAdminCreateHeaders,
  ): Promise<{ readonly invitation: CasMemberInvitation; readonly acceptUrl: string }>;
  getOAuthIssuer(path: { readonly stackId: CasStackId }): Promise<AdminClientRead<CasStackOAuthIssuer>>;
  getManagedOAuthIssuer(path: { readonly stackId: CasStackId }): Promise<AdminClientRead<CasStackOAuthIssuer>>;
  patchManagedOAuthIssuer(
    path: { readonly stackId: CasStackId },
    body: { readonly enabled: boolean },
    ifMatch: string,
  ): Promise<AdminClientRead<CasStackOAuthIssuer>>;
  mintManagedCapability(path: { readonly stackId: CasStackId }): Promise<CasManagedCapability>;
  inspectOAuthIssuer(
    path: { readonly stackId: CasStackId },
    body: {
      readonly issuer: string;
    },
  ): Promise<AdminClientRead<CasOAuthIssuerInspection>>;
  activateOAuthIssuer(
    path: { readonly stackId: CasStackId },
    body: { readonly inspectionId: string; readonly activationProof: string },
    ifMatch: string,
  ): Promise<AdminClientRead<CasStackOAuthIssuer>>;
  listRefDomains(path: { readonly stackId: CasStackId }): Promise<{ readonly domains: readonly CasRefDomain[] }>;
  listControlAuditEvents(
    path: { readonly stackId: CasStackId },
    query?: CasAdminPageQuery,
  ): Promise<CasAdminPage<CasControlAuditEvent>>;
  listRootDomainRefs(
    path: { readonly stackId: CasStackId; readonly refDomain: string },
    query?: { readonly tenantId?: string; readonly limit?: number; readonly cursor?: string },
  ): Promise<{ readonly revision: number; readonly refs: readonly CasRootRefBalance[]; readonly nextCursor: string | null }>;
  listRootDomainEvents(
    path: { readonly stackId: CasStackId; readonly refDomain: string },
    query?: { readonly tenantId?: string; readonly after?: number; readonly limit?: number },
  ): Promise<{ readonly events: readonly CasRootRefEvent[]; readonly latestRevision: number; readonly nextAfter: number }>;
}

export function createAdminClient(config: AdminClientConfig): AdminClient {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const fetcher: AdminHttpFetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);

  let session: AdminClientSession | null = null;
  const sessionProvider = async (): Promise<AdminClientSession> => {
    if (session === null) session = await config.getSession();
    return session;
  };

  const request = async (route: string, init: RequestInit = {}): Promise<Response> => {
    const current = await sessionProvider();
    const headers = new Headers(init.headers);
    headers.set("Cookie", current.cookie);
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      headers.set("X-CSRF-Token", current.csrfToken);
    }
    const response = await fetcher(`${baseUrl}${route}`, { ...init, headers });
    if (response.status === 401) {
      // The session expired or the operator was removed; force re-login.
      session = null;
    }
    return response;
  };

  const requireOk = async (response: Response, operation: string): Promise<Response> => {
    if (!response.ok) {
      const body = await response.clone().json().catch(() => null) as { error?: unknown; message?: unknown } | null;
      const code = typeof body?.error === "string" ? body.error : String(response.status);
      const message = typeof body?.message === "string" ? body.message : undefined;
      throw new AdminClientError(response.status, code, message);
    }
    return response;
  };

  const readEtag = (response: Response): string => response.headers.get(CasAdminETagHeader) ?? "";
  const queryString = (query: object | undefined): string => {
    if (query === undefined) return "";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    const encoded = params.toString();
    return encoded.length === 0 ? "" : `?${encoded}`;
  };
  const pageQuery = (query: CasAdminPageQuery | undefined): Record<string, unknown> => {
    if (query === undefined) return {};
    return {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    };
  };
  const mutationHeaders = (
    headers: CasAdminCreateHeaders | undefined,
  ): Record<string, string> => {
    if (headers?.idempotencyKey === undefined) return {};
    return { [CasAdminIdempotencyKeyHeader]: headers.idempotencyKey };
  };
  const ifMatchHeader = (ifMatch: string): Record<string, string> => ({ [CasAdminIfMatchHeader]: ifMatch });

  return {
    async me() {
      const response = await requireOk(await request(casAdminRoutes.me()), "me");
      return response.json();
    },

    async listStacks(query) {
      const response = await requireOk(
        await request(`${casAdminRoutes.stacks()}${queryString(pageQuery(query))}`),
        "listStacks",
      );
      return response.json();
    },

    async createStack(body, headers) {
      const response = await requireOk(
        await request(casAdminRoutes.stacks(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mutationHeaders(headers),
          },
          body: JSON.stringify(body),
        }),
        "createStack",
      );
      return response.json();
    },

    async getStack(path) {
      const response = await requireOk(await request(casAdminRoutes.stack(path)), "getStack");
      return { value: await response.json(), etag: readEtag(response) };
    },

    async patchStack(path, body, ifMatch) {
      const response = await requireOk(
        await request(casAdminRoutes.stack(path), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...ifMatchHeader(ifMatch) },
          body: JSON.stringify(body),
        }),
        "patchStack",
      );
      return { value: await response.json(), etag: readEtag(response) };
    },

    async listMembers(path, query) {
      const response = await requireOk(
        await request(`${casAdminRoutes.members(path)}${queryString(pageQuery(query))}`),
        "listMembers",
      );
      return response.json();
    },

    async deleteMember(path, query, ifMatch) {
      const response = await requireOk(
        await request(`${casAdminRoutes.members(path)}${queryString(query)}`, {
          method: "DELETE",
          headers: ifMatchHeader(ifMatch),
        }),
        "deleteMember",
      );
      return response.json();
    },

    async createMemberInvitation(path, body, headers) {
      const response = await requireOk(
        await request(casAdminRoutes.memberInvitations(path), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mutationHeaders(headers),
          },
          body: JSON.stringify(body),
        }),
        "createMemberInvitation",
      );
      return response.json();
    },

    async getOAuthIssuer(path) {
      const response = await requireOk(
        await request(casAdminRoutes.oauthIssuer(path)),
        "getOAuthIssuer",
      );
      return { value: await response.json(), etag: readEtag(response) };
    },

    async getManagedOAuthIssuer(path) {
      const response = await requireOk(
        await request(casAdminRoutes.managedIssuer(path)),
        "getManagedOAuthIssuer",
      );
      return { value: await response.json(), etag: readEtag(response) };
    },

    async patchManagedOAuthIssuer(path, body, ifMatch) {
      const response = await requireOk(
        await request(casAdminRoutes.managedIssuer(path), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...ifMatchHeader(ifMatch) },
          body: JSON.stringify(body),
        }),
        "patchManagedOAuthIssuer",
      );
      return { value: await response.json(), etag: readEtag(response) };
    },

    async mintManagedCapability(path) {
      const response = await requireOk(
        await request(casAdminRoutes.managedCapability(path), { method: "POST" }),
        "mintManagedCapability",
      );
      return response.json();
    },

    async inspectOAuthIssuer(path, body) {
      const response = await requireOk(
        await request(casAdminRoutes.oauthIssuerInspections(path), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        "inspectOAuthIssuer",
      );
      return { value: await response.json(), etag: readEtag(response) };
    },

    async activateOAuthIssuer(path, body, ifMatch) {
      const response = await requireOk(
        await request(casAdminRoutes.oauthIssuer(path), {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...ifMatchHeader(ifMatch) },
          body: JSON.stringify(body),
        }),
        "activateOAuthIssuer",
      );
      return { value: await response.json(), etag: readEtag(response) };
    },

    async listRefDomains(path) {
      const response = await requireOk(await request(casAdminRoutes.refDomains(path)), "listRefDomains");
      return response.json();
    },

    async listControlAuditEvents(path, query) {
      const response = await requireOk(
        await request(`${casAdminRoutes.controlAuditEvents(path)}${queryString(pageQuery(query))}`),
        "listControlAuditEvents",
      );
      return response.json();
    },

    async listRootDomainRefs(path, query) {
      const response = await requireOk(
        await request(`${casAdminRoutes.rootDomainRefs(path)}${queryString(query)}`),
        "listRootDomainRefs",
      );
      return response.json();
    },

    async listRootDomainEvents(path, query) {
      const response = await requireOk(
        await request(`${casAdminRoutes.rootDomainEvents(path)}${queryString(query)}`),
        "listRootDomainEvents",
      );
      return response.json();
    },
  };
}

