import { useSyncExternalStore } from "react";
import type { LocalLayer } from "../doc-model.js";
import type { Region } from "./region.js";
import { sweepMasks } from "./region.js";
import { expandAncestors, normalizeSelection } from "./hit-test.js";

export type ToolId = "move" | "marquee" | "eyedrop";
export type PaneId = "layers" | "props";

export interface ChatMessage {
  role: "user" | "agent" | "err";
  text: string;
  pending?: boolean;
  /** Version range this agent turn produced, so its ops accordion can slice
   *  `history` without the server needing a per-turn concept. */
  fromVersion?: number;
  toVersion?: number;
}

/** Mirrors @unidocs/protocol-doc's HistoryEntry; declared locally because
 *  web-psd has no dependency on the protocol package. */
export interface HistoryEntry {
  version: number;
  timestamp: string;
  description: string;
  operations: unknown[];
}

export interface UiState {
  docId: string | null;
  docName: string | null;
  version: number;
  doc: { canvas: { width: number; height: number }; layers: LocalLayer[] } | null;
  status: string;
  selection: string[];
  expanded: ReadonlySet<string>;
  pane: PaneId;
  tool: ToolId;
  /** The region axis of the current target. Never cleared by a layer-axis
   *  write — the two axes are written by different tools and never compete
   *  (spec §3.3). */
  region: Region | null;
  zoom: number;
  history: HistoryEntry[];
  historyOpen: boolean;
  /** The version at which the CURRENTLY OPEN document was loaded — reset
   *  every time a new document is opened (cold start, or a later
   *  `openFile`), not fixed once for the page's whole lifetime. "This
   *  session" is everything the user did since then — the server has no
   *  session concept, so the boundary lives here. */
  sessionBaseVersion: number;
  chat: ChatMessage[];
  chatBusy: boolean;
  degradeOpen: boolean;
  /** Last colour sampled by the eyedropper, shown in the context bar. */
  pickedColor: string | null;
}

const INITIAL: UiState = {
  docId: null, docName: null, version: 0, doc: null, status: "loading…",
  selection: [], expanded: new Set(), pane: "layers", tool: "move",
  region: null, zoom: 1, history: [], historyOpen: false,
  sessionBaseVersion: 0, chat: [], chatBusy: false, degradeOpen: false,
  pickedColor: null,
};

let state: UiState = INITIAL;

const listeners = new Set<() => void>();

export function getState(): UiState {
  return state;
}

export function setState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn();
}

/** Restores the module-singleton state to its initial values. `state` lives
 *  at module scope, and vitest isolates test *files*, not individual `it()`
 *  blocks, so without this every test in a file shares one mutable store —
 *  a later test can silently inherit a field a prior test left mutated
 *  (e.g. `degradeOpen`). Call from a global `afterEach` in tests. */
export function resetState(): void {
  state = INITIAL;
  for (const fn of [...listeners]) fn();
}

/**
 * Surfaces a failed request in both places the user is already looking: the
 * top bar's status line and the chat transcript.
 *
 * Three of the four network call sites are fired as `void fn()` from an
 * onClick, where a rejection is an unhandled promise rejection and NOTHING on
 * screen changes — a failed rollback or history load is silent. `send` grows
 * its own error message out of the pending bubble it already owns; everything
 * else routes through here.
 */
export function reportError(what: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const text = `${what}：${message}`;
  setState({ status: text, chat: [...getState().chat, { role: "err", text }] });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Subscribes to the WHOLE state object rather than a selector slice. That
 * re-renders every subscribed component on any change, which is fine here:
 * the expensive surface — the <canvas> — is mounted by ref and never enters
 * React's tree (see canvas-stage.tsx), and a selector-based API invites the
 * classic `useSyncExternalStore` bug where a selector returning a fresh
 * object each call loops forever.
 */
export function useUiState(): UiState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function toggleExpanded(s: UiState, id: string): ReadonlySet<string> {
  const next = new Set(s.expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Normalizes at the WRITE side — see hit-test.ts's normalizeSelection for why
 * a group plus its own child is a real bug and not a tidiness question.
 * Without a document there is no tree to normalize against, which is the
 * empty first screen, so the raw list stands.
 */
export function nextSelection(s: UiState, id: string, additive: boolean): string[] {
  const raw = !additive
    ? [id]
    : s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id];
  return s.doc ? normalizeSelection(s.doc.layers, raw) : raw;
}

export function opsSinceSession(s: UiState): HistoryEntry[] {
  return s.history.filter((e) => e.version > s.sessionBaseVersion);
}

export function selectedLayers(s: UiState): LocalLayer[] {
  if (!s.doc) return [];
  const byId = new Map<string, LocalLayer>();
  const walk = (list: LocalLayer[]): void => {
    for (const l of list) {
      byId.set(l.id, l);
      if (l.children) walk(l.children);
    }
  };
  walk(s.doc.layers);
  return s.selection.map((id) => byId.get(id)).filter((l): l is LocalLayer => !!l);
}

/**
 * The one write point for the region axis. A plain `setState({ region })`
 * works today, but every region carries a mask handle, and the bytes behind
 * discarded handles have to be released somewhere — routing every writer
 * through here means that is one edit later, not a hunt for call sites.
 *
 * This is a real invariant, not an aspiration: `region: null` must never be
 * written via a raw `setState` (controller.ts learned this the hard way —
 * its document-open and canvas-resize paths both used to bypass this and
 * leak a full-canvas mask). If you're about to write `region` outside this
 * function, route it through here instead, even if that means splitting an
 * otherwise-combined `setState` into two calls.
 */
export function setRegion(region: Region | null): void {
  setState({ region });
  sweepMasks(region?.maskId ?? null);
}

/**
 * The one write point for the layer axis.
 *
 * Everything a selection has to drag along with it lives here rather than at
 * each call site: normalization (see hit-test.ts) and opening the tree far
 * enough that the newly selected row is actually rendered. The canvas, the
 * degradation badge and the tree itself all go through it.
 */
export function selectLayer(id: string, opts: { additive?: boolean } = {}): void {
  const s = getState();
  const selection = nextSelection(s, id, !!opts.additive);
  setState({
    selection,
    ...(s.doc ? { expanded: expandAncestors(s.doc.layers, id, s.expanded) } : {}),
  });
}

/** Replaces the layer axis outright (region → layers, Esc, click on empty
 *  canvas). Normalized for the same reason `selectLayer` is. */
export function setSelection(ids: string[]): void {
  const s = getState();
  setState({ selection: s.doc ? normalizeSelection(s.doc.layers, ids) : ids });
}
