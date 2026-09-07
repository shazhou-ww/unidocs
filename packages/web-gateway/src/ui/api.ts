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
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

export interface GatewayListResponse {
  readonly success: boolean;
  readonly data: GatewayDocumentRecord[];
  readonly count: number;
}

export interface GatewayCreateResponse {
  readonly success: boolean;
  readonly docId: string;
  readonly version?: number;
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

async function gatewayFetch(path: string, init: RequestInit = {}, expectedTenant?: string): Promise<Response> {
  const session = await ensureFreshSession();
  if (expectedTenant && session.tenantId !== expectedTenant) throw new ApiError(403, "账号上下文已改变，请重新打开作品");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.accessToken}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (response.status === 401) {
    const refreshed = await refreshSession(session);
    if (expectedTenant && refreshed.tenantId !== expectedTenant) throw new ApiError(403, "账号上下文已改变，请重新打开作品");
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

export interface MarkdownPreview {
  content: string;
  version: number;
}

export async function readMarkdownPreview(tenantId: string, docId: string, signal: AbortSignal): Promise<MarkdownPreview> {
  const response = await gatewayFetch(`/tenants/${encodeURIComponent(tenantId)}/docs/markdown/${encodeURIComponent(docId)}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ kind: "getContent" }), signal, cache: "no-store",
  }, tenantId);
  const result = await readJson<{ data: unknown; version: number }>(response);
  if (typeof result.data !== "string" || !Number.isSafeInteger(result.version) || result.version < 1) throw new ApiError(502, "文档内容或版本格式无效");
  return { content: result.data, version: result.version };
}

export function createPsdPreviewTransport(tenantId: string, docId: string, signal: AbortSignal): { apiBaseUrl: string; fetchImpl: typeof fetch } {
  const path = `/tenants/${encodeURIComponent(tenantId)}`;
  const apiBaseUrl = `${API_BASE}${path}`;
  const irUrl = `${apiBaseUrl}/docs/psd/${encodeURIComponent(docId)}/ir`;
  const pixelsPrefix = `${apiBaseUrl}/cas/nodes/`;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if ((init.method ?? "GET") !== "GET" || init.body != null
      || (url !== irUrl && !(url.startsWith(pixelsPrefix) && /^[a-f0-9]{64}\/content$/.test(url.slice(pixelsPrefix.length))))) {
      throw new ApiError(403, "只读预览拒绝此请求");
    }
    const response = await gatewayFetch(url.slice(API_BASE.length), { method: "GET", signal, cache: "no-store" }, tenantId);
    if (!response.ok) throw new ApiError(response.status, `预览读取失败 (${response.status})`);
    if (url === irUrl) {
      const version = Number(response.headers.get("X-Doc-Version"));
      if (!Number.isSafeInteger(version) || version < 1) throw new ApiError(502, "作品响应缺少有效版本号");
    }
    return response;
  };
  return { apiBaseUrl, fetchImpl };
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

export async function listDocuments(tenantId: string, docType: string, signal?: AbortSignal): Promise<GatewayDocumentRecord[]> {
  const body = await readJson<GatewayListResponse>(
    await gatewayFetch(`/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/`, { signal, cache: "no-store" }, tenantId),
  );
  return body.data ?? [];
}

export async function createDocument(tenantId: string, docType: string): Promise<GatewayCreateResponse> {
  return readJson<GatewayCreateResponse>(
    await gatewayFetch(`/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, tenantId),
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
