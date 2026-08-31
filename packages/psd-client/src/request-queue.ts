/**
 * The render Worker's message queue: strictly serial, with one discardable
 * slot.
 *
 * Serial because the Worker holds ONE resident RenderCore — letting an async
 * handler's `await` points interleave two mutations of it (or race an applyOp
 * against a tile read mid-composite) is the bug this replaced a bare
 * `onmessage` to avoid.
 *
 * The discardable slot exists because hover hit tests arrive once per frame
 * and would otherwise queue behind a whole batch of tiles during a pan: at
 * most ONE hover request waits, a newer one replaces it, and it only runs
 * when nothing else is in flight. Losing a frame of hover highlight costs
 * nothing — the next frame supplies it — while arriving several hundred
 * milliseconds late is exactly what it feels like.
 *
 * A superseded request is handed to `drop` rather than forgotten: callers
 * hold a promise keyed by request id, and one that is never answered is a
 * leaked map entry plus a promise that never settles.
 */
export interface QueueHooks<Req> {
  run(req: Req): Promise<void>;
  drop(req: Req): void;
  discardable(req: Req): boolean;
}

export function createRequestQueue<Req>(hooks: QueueHooks<Req>): { submit(req: Req): void } {
  // Non-discardable requests that arrived while something else was running,
  // in arrival order. Only ever non-empty while `active` is true — as soon
  // as the running request finishes, the next pending one starts.
  const pending: Req[] = [];
  // At most one discardable (hover) request waiting for its turn. A new one
  // replaces — never appends to — this single slot.
  let waiting: Req | null = null;
  let active = false;

  const start = (req: Req): void => {
    active = true;
    // Call `run` synchronously rather than via `Promise.resolve().then(...)`:
    // when the queue is idle, a submitted request starts in the same tick
    // it was submitted in, not one microtask later. Nothing downstream
    // depends on that timing, but it keeps "submit" meaning "starts now
    // unless something is in the way," which is what discardability is
    // reasoning about.
    Promise.resolve(hooks.run(req))
      // `run` already reports every request-scoped failure to its own
      // caller, so this is a backstop for anything escaping it. Without it a
      // rejection would propagate past this point and the pending/waiting
      // requests behind it would never start — one bad message wedging the
      // Worker for the rest of the session.
      .catch((err) => { console.error("request-queue: unhandled error draining queue", err); })
      .then(() => {
        active = false;
        advance();
      });
  };

  const advance = (): void => {
    const next = pending.shift();
    if (next !== undefined) { start(next); return; }
    if (waiting) {
      const req = waiting;
      waiting = null;
      start(req);
    }
  };

  return {
    submit(req: Req): void {
      if (hooks.discardable(req)) {
        if (!active) { start(req); return; }
        if (waiting) hooks.drop(waiting);
        waiting = req;
        return;
      }
      if (!active) { start(req); return; }
      pending.push(req);
    },
  };
}
