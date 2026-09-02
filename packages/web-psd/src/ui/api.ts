import { SValueContentType } from "@unidocs/protocol";
import { decodeSValue } from "@unidocs/svalue-codec";
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

/**
 * History carries each delta's `operations`, and since `editPixels` an op
 * payload can hold a CAS blob reference (`generative_fill` roots the result
 * layer's pixels that way). A reference has **no JSON projection by design** —
 * `svalue-codec`'s `toJsonValue` throws on SBlob rather than invent one — so
 * the editor answers a plain `Accept: *` request with 406 instead of handing
 * back a payload it cannot represent faithfully.
 *
 * So ask for SValue and decode it. The browser already carries the codec
 * (`psd-client` decodes snapshots with it), and this keeps `operations`
 * intact: dropping a field because today's drawer only reads version /
 * timestamp / description would just move the breakage to whoever reads it
 * next.
 */
export async function fetchHistory(docId: string): Promise<HistoryEntry[]> {
  const res = await fetch(docUrl(docId, "history"), { headers: { accept: SValueContentType } });
  // Same rule as readJson: a transport failure must never be mistaken for a
  // payload. Read it as text — an error response is as likely to be HTML.
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const envelope = decodeSValue(new Uint8Array(await res.arrayBuffer())) as unknown as {
    success?: boolean;
    error?: string;
    data?: HistoryEntry[];
  };
  if (envelope.success === false) throw new Error(envelope.error ?? "request failed");
  return envelope.data ?? [];
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

/**
 * The selection target as the agent gets to see it.
 *
 * Carries the layer **id AND name**. It used to be names only, on the reasoning
 * that "ids mean nothing to the agent and only cost tokens" — that predates
 * editPixels, whose first argument IS a layerId. Sending only a name forces a
 * getLayers round trip to translate it, and a PSD may well hold several layers
 * with the same name, in which case the translation is a guess.
 *
 * `bounds` is absent when the target is a layer selection rather than a dragged
 * region: a layer has bounds of its own that the agent can read from getLayers,
 * and inventing a rectangle here would say something the user did not.
 */
export interface AgentTargetLayer {
  id: string;
  name: string;
}
export interface AgentTarget {
  bounds?: [number, number, number, number];
  layers: AgentTargetLayer[];
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
  const bounds = target.bounds ? ` bounds=[${target.bounds.join(",")}]` : "";
  const layers = target.layers.length > 0
    ? ` layers=[${target.layers.map((l) => JSON.stringify(l)).join(",")}]`
    : "";
  // 两半都空就别发标记：一个 `<<selection>>` 空壳只会让 agent 以为用户
  // 指了什么而其实没有。
  return bounds || layers ? `<<selection${bounds}${layers}>>\n${instruction}` : instruction;
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
