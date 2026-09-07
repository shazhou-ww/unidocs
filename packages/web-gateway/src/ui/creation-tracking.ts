import type { OAuthTokenSession } from "./oauth.js";

export const CREATION_TRACKING_KEY = "unidocs.creation-tracking.v1";
export interface PendingCreation { docType: string; docId: string; }

export function creationTrackingScope(session: OAuthTokenSession): string | null {
  try {
    const segment = session.accessToken.split(".")[1];
    if (!segment) return null;
    const encoded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), value => value.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims.iss !== "string" || !claims.iss || typeof claims.sub !== "string" || !claims.sub) return null;
    return JSON.stringify([claims.iss, claims.sub, session.tenantId]);
  } catch { return null; }
}

function validateItems(value: unknown): PendingCreation[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("创建跟踪记录过多或格式不兼容");
  const items = new Map<string, PendingCreation>();
  for (const item of value) {
    if (!item || typeof item.docType !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(item.docType)
      || typeof item.docId !== "string" || !item.docId || item.docId.length > 512) throw new Error("创建跟踪记录格式不兼容");
    const record = { docType: item.docType, docId: item.docId };
    items.set(JSON.stringify([record.docType, record.docId]), record);
  }
  return [...items.values()];
}

export function readCreationTracking(scope: string | null, storage: Storage = sessionStorage): PendingCreation[] {
  if (!scope) throw new Error("无法识别创建跟踪的登录身份");
  const raw = storage.getItem(CREATION_TRACKING_KEY);
  if (!raw) return [];
  if (raw.length > 100_000) throw new Error("创建跟踪记录超出读取上限");
  const record = JSON.parse(raw);
  if (record?.schema !== 1 || typeof record.scope !== "string") throw new Error("创建跟踪记录格式不兼容");
  if (record.scope !== scope) return [];
  return validateItems(record.items);
}

export function writeCreationTracking(scope: string | null, items: PendingCreation[], storage: Storage = sessionStorage): void {
  if (!scope) throw new Error("无法识别创建跟踪的登录身份");
  const validated = validateItems(items);
  storage.setItem(CREATION_TRACKING_KEY, JSON.stringify({ schema: 1, scope, items: validated }));
}