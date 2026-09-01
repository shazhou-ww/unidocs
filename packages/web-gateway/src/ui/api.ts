/**
 * Gateway data-plane API client: document list/create/status/export with
 * bearer-token auth and one refresh-and-retry on 401.
 */

import { API_BASE } from "./config.js";
import {
  clearSession,
  loadSession,
  refreshSession,
  sessionIsExpired,
  type OAuthTokenSession,
} from "./oauth.js";

export interface GatewayDocumentRecord {
  readonly doc_id: string;
  readonly doc_type: string;
  readonly owner_id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GatewayListResponse {
  readonly success: boolean;
  readonly data: GatewayDocumentRecord[];
  readonly count: number;
}

export interface GatewayCreateResponse {
  readonly success: boolean;
  readonly docId: string;
  readonly version: number;
  readonly state?: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function ensureFreshSession(): Promise<OAuthTokenSession> {
  let session = loadSession();
  if (!session) throw new ApiError(401, "Not signed in");
  if (sessionIsExpired(session)) {
    session = await refreshSession(session);
  }
  return session;
}

async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await ensureFreshSession();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.accessToken}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (response.status === 401) {
    const refreshed = await refreshSession(session);
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set("Authorization", `Bearer ${refreshed.accessToken}`);
    const retry = await fetch(`${API_BASE}${path}`, { ...init, headers: retryHeaders });
    if (retry.status === 401) {
      clearSession();
      throw new ApiError(401, "Session expired; please sign in again");
    }
    return retry;
  }
  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
    throw new ApiError(response.status, `HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await response.json()) as { success?: boolean; error?: string } & T;
  if (body.success === false) throw new ApiError(response.status, body.error ?? "request failed");
  return body;
}

export async function listDocuments(tenantId: string, docType: string): Promise<GatewayDocumentRecord[]> {
  const body = await readJson<GatewayListResponse>(
    await gatewayFetch(`/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/`),
  );
  return body.data ?? [];
}

export async function createDocument(tenantId: string, docType: string): Promise<GatewayCreateResponse> {
  return readJson<GatewayCreateResponse>(
    await gatewayFetch(`/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
}

export async function documentStatus(
  tenantId: string,
  docType: string,
  docId: string,
): Promise<GatewayCreateResponse> {
  return readJson<GatewayCreateResponse>(
    await gatewayFetch(
      `/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/${encodeURIComponent(docId)}`,
    ),
  );
}

/** Downloads an exported document through the authenticated API as a blob. */
export async function downloadDocument(
  tenantId: string,
  docType: string,
  docId: string,
  filename: string,
): Promise<void> {
  const response = await gatewayFetch(
    `/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/${encodeURIComponent(docId)}/export`,
  );
  if (!response.ok) {
    throw new ApiError(response.status, `export failed with ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
