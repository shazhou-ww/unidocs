import { useSyncExternalStore } from "react";

/**
 * The hovered layer id, deliberately NOT in the main store.
 *
 * `store.ts` subscribes components to the whole state object, so every
 * `setState` re-renders the entire tree — including the layer panel's few
 * hundred rows. Hover changes on every `pointermove`; routing it through
 * there would re-render that tree per frame. Here, one hover change costs one
 * div, because the selection overlay is the only subscriber.
 *
 * Same shape as the main store (subscribe / getSnapshot /
 * useSyncExternalStore) so there is one idiom to learn, not two.
 */
let hoverId: string | null = null;
const listeners = new Set<() => void>();

export function getHoverId(): string | null {
  return hoverId;
}

/** No-ops when unchanged: the hit test reports the same layer for most frames
 *  of a slow drag across it, and every one of those would otherwise be a
 *  render. */
export function setHoverId(id: string | null): void {
  if (id === hoverId) return;
  hoverId = id;
  for (const fn of [...listeners]) fn();
}

export function subscribeHover(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useHoverId(): string | null {
  return useSyncExternalStore(subscribeHover, getHoverId, getHoverId);
}
