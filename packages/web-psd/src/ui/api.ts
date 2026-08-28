import { API_BASE_URL, TYPE } from "../doc-controller.js";
import type { HistoryEntry } from "./store.js";

const docUrl = (docId: string, method: string): string =>
  `${API_BASE_URL}/docs/${TYPE}/${docId}/${method}`;

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json() as { success?: boolean; error?: string } & T;
  if (body.success === false) throw new Error(body.error ?? "request failed");
  return body;
}

export async function fetchHistory(docId: string): Promise<HistoryEntry[]> {
  const body = await readJson<{ data?: HistoryEntry[] }>(await fetch(docUrl(docId, "history")));
  return body.data ?? [];
}

/** Rolls the document back to `version`. Rollback moves the version FORWARD
 *  (it appends a synthetic delta), so the returned number is the new head. */
export async function rollback(docId: string, version: number): Promise<number> {
  const body = await readJson<{ version: number }>(await fetch(docUrl(docId, "rollback"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  }));
  return body.version;
}

export async function runAgent(docId: string, instruction: string): Promise<string> {
  const body = await readJson<{ data?: { response?: string } }>(await fetch(docUrl(docId, "run"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction }),
  }));
  const reply = body.data?.response;
  return typeof reply === "string" && reply.trim() ? reply : "(done)";
}

/** Clears the Operator's in-memory conversation for this document. */
export async function resetAgent(docId: string): Promise<void> {
  await readJson(await fetch(docUrl(docId, "reset"), { method: "POST" }));
}
