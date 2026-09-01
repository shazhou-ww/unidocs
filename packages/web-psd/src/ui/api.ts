import { API_BASE_URL, TYPE } from "../doc-controller.js";
import type { HistoryEntry } from "./store.js";

const docUrl = (docId: string, method: string): string =>
  `${API_BASE_URL}/docs/${TYPE}/${docId}/${method}`;

async function readJson<T>(res: Response): Promise<T> {
  // A transport-level failure must never be mistaken for a payload. Without
  // this gate a 404/500 that happens to carry any JSON body flowed straight
  // through: `fetchHistory` turned it into `[]` — indistinguishable from "this
  // session changed nothing" — and a failed `/rollback` looked exactly like a
  // successful one that changed nothing. Read the body as TEXT here, since an
  // error response is just as likely to be an HTML error page or empty.
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
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

/** The selection target as the agent gets to see it. Layer NAMES, not ids:
 *  names are what the agent can match against its own `getLayers` result;
 *  ids mean nothing to it and only cost tokens. */
export interface AgentTarget {
  bounds: [number, number, number, number];
  layerNames: string[];
}

/**
 * Splices the current target into the instruction text.
 *
 * DELIBERATELY A STOPGAP (spec §4.3). The real fix widens
 * `DocRunOperatorRequest.body` from `{ instruction }` to
 * `{ instruction, region? }` and carries a mask through CAS — a cross-package
 * change that needs its own design. This gets the main path working today,
 * and real usage is what will show which fields the agent actually needs,
 * which is more reliable than guessing the protocol first.
 *
 * Being a string convention rather than a typed contract, three things are
 * pinned down: an unlikely-to-collide delimiter, emitted ONCE at the front
 * (users type brackets, and the operator keeps conversation memory across
 * turns — a marker in the middle would leave it with two bounds and no way to
 * tell which is current); and layer names only.
 */
export function withTarget(instruction: string, target: AgentTarget | null): string {
  if (!target) return instruction;
  const [top, left, bottom, right] = target.bounds;
  const layers = target.layerNames.length > 0
    ? ` layers=[${target.layerNames.map((n) => JSON.stringify(n)).join(",")}]`
    : "";
  return `<<selection bounds=[${top},${left},${bottom},${right}]${layers}>>\n${instruction}`;
}

export async function runAgent(docId: string, instruction: string, target: AgentTarget | null = null): Promise<string> {
  const body = await readJson<{ data?: { response?: string } }>(await fetch(docUrl(docId, "run"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: withTarget(instruction, target) }),
  }));
  const reply = body.data?.response;
  return typeof reply === "string" && reply.trim() ? reply : "(done)";
}

/** Clears the Operator's in-memory conversation for this document. */
export async function resetAgent(docId: string): Promise<void> {
  await readJson(await fetch(docUrl(docId, "reset"), { method: "POST" }));
}
