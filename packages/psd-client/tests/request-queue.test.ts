import { describe, it, expect, vi } from "vitest";
import { createRequestQueue } from "../src/request-queue.js";

interface Req { id: number; hover?: boolean }

function harness() {
  const started: number[] = [];
  const dropped: number[] = [];
  const gates = new Map<number, () => void>();
  const queue = createRequestQueue<Req>({
    run: (req) => { started.push(req.id); return new Promise<void>((resolve) => gates.set(req.id, resolve)); },
    drop: (req) => { dropped.push(req.id); },
    discardable: (req) => !!req.hover,
  });
  const finish = async (id: number): Promise<void> => { gates.get(id)!(); await Promise.resolve(); await Promise.resolve(); };
  return { queue, started, dropped, finish };
}

describe("createRequestQueue", () => {
  it("runs non-discardable requests strictly in arrival order, one at a time", async () => {
    const h = harness();
    h.queue.submit({ id: 1 });
    h.queue.submit({ id: 2 });
    expect(h.started).toEqual([1]);
    await h.finish(1);
    expect(h.started).toEqual([1, 2]);
  });

  // Tiles and hover both go through one worker. A hover point that is already
  // stale by the time its turn comes is worth nothing; the frame after it is
  // the answer anyone actually sees.
  it("replaces a waiting hover request instead of appending it", async () => {
    const h = harness();
    h.queue.submit({ id: 1 });               // real work, in flight
    h.queue.submit({ id: 2, hover: true });
    h.queue.submit({ id: 3, hover: true });
    expect(h.started).toEqual([1]);
    expect(h.dropped).toEqual([2]);          // superseded, and settled
    await h.finish(1);
    expect(h.started).toEqual([1, 3]);
  });

  it("runs a hover request immediately when nothing else is queued", () => {
    const h = harness();
    h.queue.submit({ id: 9, hover: true });
    expect(h.started).toEqual([9]);
  });

  // A rejected handler must not poison the chain: one bad message would
  // otherwise wedge the worker for the rest of the session.
  it("keeps draining after a request rejects", async () => {
    const started: number[] = [];
    const queue = createRequestQueue<Req>({
      run: async (req) => { started.push(req.id); if (req.id === 1) throw new Error("boom"); },
      drop: () => {}, discardable: () => false,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    queue.submit({ id: 1 });
    queue.submit({ id: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1, 2]);
  });
});
