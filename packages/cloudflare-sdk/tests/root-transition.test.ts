import { describe, expect, it } from "vitest";
import { rootTransitionChanges } from "../src/root-transition.js";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const S1 = "c".repeat(64);
const S2 = "d".repeat(64);

describe("rootTransitionChanges", () => {
  it("first version retains delta and snapshot without releases", () => {
    expect(rootTransitionChanges(
      { delta: null, snapshot: null },
      { delta: H1, snapshot: S1 },
    )).toEqual({ [H1]: 1, [S1]: 1 });
  });

  it("replacement releases the previous delta and snapshot", () => {
    expect(rootTransitionChanges(
      { delta: H1, snapshot: S1 },
      { delta: H2, snapshot: S2 },
    )).toEqual({ [H2]: 1, [S1]: -1, [S2]: 1, [H1]: -1 });
  });

  it("snapshot-less version keeps the previous snapshot retained", () => {
    expect(rootTransitionChanges(
      { delta: H1, snapshot: S1 },
      { delta: H2, snapshot: null },
    )).toEqual({ [H2]: 1, [H1]: -1 });
  });

  it("re-settling an already-retained set produces an empty map (retry idempotency)", () => {
    expect(rootTransitionChanges(
      { delta: H1, snapshot: S1 },
      { delta: H1, snapshot: S1 },
    )).toEqual({});
  });

  it("same delta with a new snapshot only transitions the snapshot", () => {
    expect(rootTransitionChanges(
      { delta: H1, snapshot: S1 },
      { delta: H1, snapshot: S2 },
    )).toEqual({ [S2]: 1, [S1]: -1 });
  });

  it("new delta with the same snapshot only transitions the delta", () => {
    expect(rootTransitionChanges(
      { delta: H1, snapshot: S1 },
      { delta: H2, snapshot: S1 },
    )).toEqual({ [H2]: 1, [H1]: -1 });
  });

  it("first delta with no snapshot retains only the delta", () => {
    expect(rootTransitionChanges(
      { delta: null, snapshot: null },
      { delta: H1, snapshot: null },
    )).toEqual({ [H1]: 1 });
  });
});
