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
  OAuthError,
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

const pendingRefresh = new Map<string, Promise<OAuthTokenSession>>();

function refreshOnce(session: OAuthTokenSession): Promise<OAuthTokenSession> {
  const current = loadSession();
  if (!current) return Promise.reject(new ApiError(401, "请重新登录"));
  if (current.accessToken !== session.accessToken || current.refreshToken !== session.refreshToken) return Promise.resolve(current);
  const key = session.refreshToken || session.accessToken;
  const pending = pendingRefresh.get(key);
  if (pending) return pending;
  const request = refreshSession(session).catch(reason => {
    if (reason instanceof OAuthError && ["invalid_grant", "no_refresh_token"].includes(reason.code)) {
      const latest = loadSession();
      if (latest?.refreshToken === session.refreshToken && latest?.accessToken === session.accessToken) clearSession();
      throw new ApiError(401, "登录已失效，请重新登录");
    }
    throw reason;
  }).finally(() => { pendingRefresh.delete(key); });
  pendingRefresh.set(key, request);
  return request;
}

async function ensureFreshSession(): Promise<OAuthTokenSession> {
  let session = loadSession();
  if (!session) throw new ApiError(401, "Not signed in");
  if (sessionIsExpired(session)) {
    session = await refreshOnce(session);
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
    const refreshed = await refreshOnce(session);
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

export interface CreateDocumentOptions {
  file: File;
  requestId: string;
}

export function validateImportFile(docType: string, file: File): void {
  const extensions: Record<string, RegExp> = { markdown: /\.(md|markdown)$/i, psd: /\.psd$/i };
  if (!extensions[docType]?.test(file.name)) throw new ApiError(400, "请选择与内容类型匹配的 Markdown 或 PSD 文件");
  if (file.size === 0) throw new ApiError(400, "不能导入空文件");
  if (file.size > 32 * 1024 * 1024) throw new ApiError(413, "本轮导入支持不超过 32 MiB 的文件");
}

export async function createDocument(tenantId: string, docType: string, options?: CreateDocumentOptions): Promise<GatewayCreateResponse> {
  let body: BodyInit = JSON.stringify({});
  const headers = new Headers();
  if (options) {
    validateImportFile(docType, options.file);
    if (!options.requestId) throw new ApiError(400, "导入请求缺少标识");
    const form = new FormData(); form.append("file", options.file); form.append("format", docType);
    body = form;
    headers.set("Idempotency-Key", options.requestId);
  } else headers.set("Content-Type", "application/json");
  return readJson<GatewayCreateResponse>(
    await gatewayFetch(`/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/`, {
      method: "POST",
      headers,
      body,
    }, tenantId),
  );
}

export interface GatewayDocumentStatus {
  doc_id: string;
  doc_type: string;
  state: "creating" | "ready" | "failed";
  version: number | null;
}

export async function documentStatus(
  tenantId: string,
  docType: string,
  docId: string,
  signal?: AbortSignal,
): Promise<GatewayDocumentStatus> {
  const body = await readJson<{ data: GatewayDocumentStatus }>(
    await gatewayFetch(
      `/tenants/${encodeURIComponent(tenantId)}/docs/${encodeURIComponent(docType)}/${encodeURIComponent(docId)}`,
      { signal, cache: "no-store" }, tenantId,
    ),
  );
  const data = body.data;
  if (!data || data.doc_id !== docId || data.doc_type !== docType
    || !["creating", "ready", "failed"].includes(data.state)
    || (data.state === "ready" && (!Number.isSafeInteger(data.version) || data.version! < 1))) {
    throw new ApiError(502, "创建状态响应无效，未确认作品就绪");
  }
  return data;
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
