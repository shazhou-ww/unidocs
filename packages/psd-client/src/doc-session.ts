import { applyOne, deserialize } from "@unidocs/doctype-psd/engine";
import type { BlobStore, PsdDoc, PsdOp } from "@unidocs/doctype-psd/engine";

type Rect = [number, number, number, number];

/** What `DocSession` needs from a render backend: paint one op immediately
 *  (`applyOp`) and swap in a rebased doc without a cold re-init (`reset`).
 *  `RenderClient` satisfies this; tests inject a mock that just records
 *  calls. */
export interface RenderLike {
  applyOp(op: PsdOp): Promise<Rect>;
  reset(doc: PsdDoc): Promise<void>;
}

interface PendingEntry {
  op: PsdOp;
  opId: string;
}

interface ApplyResponse {
  success: boolean;
  version: number;
}

interface SnapshotResponse {
  success: boolean;
  version: number;
  hash: string;
}

/** Default `opId` generator: a one-time random session nonce plus a
 *  monotonic counter, so ids stay unique within a session and across
 *  sessions (the nonce) without any server round trip. Tests inject a
 *  deterministic `genId` instead. */
function defaultGenId(): () => string {
  const nonce = Math.random().toString(36).slice(2);
  let counter = 0;
  return () => `${nonce}-${counter++}`;
}

/**
 * Client-side sync core for a PSD doc session. Holds the authoritative
 * local doc + `baseVersion` + a per-op pending queue, and is the one place
 * that knows how to reconcile local edits with the server:
 *
 * - `applyLocal(op)` advances the local doc and paints it immediately
 *   (via `RenderLike.applyOp`) — it never waits on the network — then
 *   queues the op for background submission.
 * - A background drain serially POSTs queued ops to `/apply`, carrying
 *   each op's `baseVersion` and a stable `opId` (generated once, reused on
 *   every resubmit so the server can dedup a lost-ack retry).
 * - On a 409 (or after an out-of-band server change, via `reconcile()`,
 *   e.g. following an agent `/run`), it rebases: fetch the server's latest
 *   snapshot, replay the still-pending ops on top of it (dropping any that
 *   no longer apply — e.g. their target layer is gone), and warm-reset the
 *   render onto the replayed doc (reusing the render's resident pixel
 *   cache rather than cold re-initializing).
 *
 * The server remains the source of truth: the local doc is always "some
 * baseVersion plus a local pending queue," and rebase always re-derives
 * from the server's current state.
 */
export class DocSession {
  readonly #gw: string;
  readonly #user: string;
  readonly #type: string;
  readonly #docId: string;
  readonly #store: BlobStore;
  readonly #render: RenderLike;
  readonly #fetchImpl: typeof fetch;
  readonly #genId: () => string;
  readonly #onRebase?: (doc: PsdDoc) => void;

  #doc: PsdDoc;
  #version: number;
  #pending: PendingEntry[] = [];
  #draining: Promise<void> | null = null;

  // Serializes every read-modify-write of `#pending`/`#version` — a
  // promise-chain mutex. `#drain`'s single-flight flag only prevents two
  // drain loops from overlapping each other; it does nothing to stop a
  // `reconcile()` rebase from running concurrently with a drain iteration
  // parked on `await fetch(.../apply)`. Without this, a stale response for
  // an op a rebase already dropped (or reordered out of `#pending`) can
  // land after the rebase, and an unconditional `#version = ...; shift()`
  // both regresses `#version` past what the rebase just set AND removes
  // whatever now happens to be `#pending[0]` — silently losing an
  // unrelated op. Routing both the drain loop's per-op critical section
  // and `reconcile`'s rebase through `#locked` guarantees a rebase can
  // only run *between* drain iterations, never mid-fetch.
  #mutex: Promise<unknown> = Promise.resolve();

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#mutex.then(fn, fn);
    // Keep the chain alive even if `fn` rejects — a failed step must not
    // wedge the mutex for every future locked call.
    this.#mutex = run.catch(() => {});
    return run;
  }

  constructor(opts: {
    gw: string;
    user: string;
    type: string;
    docId: string;
    doc: PsdDoc;
    version: number;
    store: BlobStore;
    render: RenderLike;
    fetchImpl?: typeof fetch;
    genId?: () => string;
    /** Called at the end of every rebase (both the autonomous 409-during-drain
     *  path and an explicit `reconcile()`) with the rebased `#doc`, so a
     *  caller can resync the UI (repaint tiles, refresh a layers panel, etc.)
     *  even when the rebase wasn't triggered by a user-visible action — e.g.
     *  a 409 firing on a background drain while an agent `/run` (or another
     *  tab) is mid-flight. Optional; a no-op if omitted. */
    onRebase?: (doc: PsdDoc) => void;
  }) {
    this.#gw = opts.gw;
    this.#user = opts.user;
    this.#type = opts.type;
    this.#docId = opts.docId;
    this.#store = opts.store;
    this.#render = opts.render;
    this.#fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#genId = opts.genId ?? defaultGenId();
    this.#onRebase = opts.onRebase;
    this.#doc = opts.doc;
    this.#version = opts.version;
  }

  get doc(): PsdDoc {
    return this.#doc;
  }

  get version(): number {
    return this.#version;
  }

  /** Advances the local doc and paints the op immediately, then queues it
   *  for background submission. Does NOT await the server — the returned
   *  rect reflects only the local `applyOne` + render, so callers get an
   *  immediate paint regardless of network latency. */
  async applyLocal(op: PsdOp): Promise<Rect> {
    this.#doc = applyOne(this.#doc, op);
    this.#pending.push({ op, opId: this.#genId() });
    const rect = await this.#render.applyOp(op);
    // Fire-and-forget: a non-409 failure (e.g. a 500 or a network throw)
    // must not become an unhandled rejection — the op just stays queued
    // and gets retried on the next drain kick (next `applyLocal`/`reconcile`).
    void this.#drain().catch((err) => {
      console.warn("DocSession: background drain failed; pending ops remain queued for retry", err);
    });
    return rect;
  }

  /** Reconciles the local doc with the server after an out-of-band change
   *  (e.g. an agent `/run` that mutated the doc server-side): rebases onto
   *  the server's latest snapshot, replaying any still-pending local ops
   *  on top. Uses the same rebase path a 409 triggers during drain — and,
   *  like drain, runs the rebase through `#locked` so it can't interleave
   *  with a drain iteration parked mid-fetch. */
  async reconcile(): Promise<void> {
    await this.#locked(() => this.#rebase());
    void this.#drain().catch((err) => {
      console.warn("DocSession: background drain failed; pending ops remain queued for retry", err);
    });
  }

  /** Kicks off the background submit loop if it isn't already running.
   *  Single-flight: concurrent calls (e.g. from back-to-back `applyLocal`s)
   *  share the one in-flight loop rather than starting overlapping drains
   *  — the loop re-reads `#pending[0]` each iteration, so ops queued while
   *  it's already running are picked up without a second loop. */
  #drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    const run = this.#drainLoop().finally(() => {
      this.#draining = null;
    });
    this.#draining = run;
    return run;
  }

  async #drainLoop(): Promise<void> {
    // Each iteration's fetch + commit (or fetch + rebase) is ONE `#locked`
    // unit, so a `reconcile()` rebase queued on the mutex can only start
    // once the whole iteration — including its `await fetch` — has
    // settled, never while it's parked mid-flight.
    for (;;) {
      const more = await this.#locked(() => this.#drainStep());
      if (!more) return;
    }
  }

  /** One drain iteration, run under `#mutex`: submit the current head of
   *  `#pending`, and either commit its result or trigger a rebase. Returns
   *  whether the loop should keep going. */
  async #drainStep(): Promise<boolean> {
    const entry = this.#pending[0];
    if (!entry) return false;

    const res = await this.#fetchImpl(`${this.#gw}/users/${this.#user}/docs/${this.#type}/${this.#docId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: [entry.op], baseVersion: this.#version, opId: entry.opId }),
    });

    if (res.status === 409) {
      // #rebase() runs in the same locked unit — no other `#locked` caller
      // can observe `#pending`/`#version` mid-rebase.
      await this.#rebase();
      return true;
    }
    if (!res.ok) {
      throw new Error(`DocSession: /apply failed with status ${res.status}`);
    }
    const body = (await res.json()) as ApplyResponse;
    // Belt-and-suspenders: the mutex already guarantees nothing can rebase
    // `#pending` while this fetch was in flight, so `#pending[0]` is still
    // `entry` here — but guard the commit on it anyway rather than relying
    // solely on scheduling analysis.
    if (this.#pending[0] === entry) {
      this.#version = body.version;
      this.#pending.shift();
    }
    return true;
  }

  /** Fetches the server's current snapshot, deserializes it into a fresh
   *  base doc, and replays `#pending` on top — dropping (with a warning,
   *  not a throw) any op that no longer applies, e.g. because its target
   *  layer was removed by whatever changed the doc server-side. Updates
   *  `#doc`/`#version`/`#pending` and warm-resets the render onto the
   *  replayed doc. */
  async #rebase(): Promise<void> {
    const res = await this.#fetchImpl(`${this.#gw}/users/${this.#user}/docs/${this.#type}/${this.#docId}/snapshot`);
    if (!res.ok) throw new Error(`DocSession: snapshot fetch failed with status ${res.status}`);
    const snap = (await res.json()) as SnapshotResponse;

    const ir = await this.#store.get(snap.hash);
    if (ir === null) throw new Error(`DocSession: IR blob missing for hash "${snap.hash}"`);
    const base = await deserialize(ir, this.#store);

    let doc = base;
    const survivors: PendingEntry[] = [];
    for (const entry of this.#pending) {
      try {
        doc = applyOne(doc, entry.op);
        survivors.push(entry);
      } catch (err) {
        console.warn(
          `DocSession: dropping pending op "${entry.op.kind}" during rebase — it no longer applies to the server's latest doc`,
          err,
        );
      }
    }

    this.#doc = doc;
    this.#pending = survivors;
    this.#version = snap.version;
    await this.#render.reset(this.#doc);
    this.#onRebase?.(this.#doc);
  }
}
