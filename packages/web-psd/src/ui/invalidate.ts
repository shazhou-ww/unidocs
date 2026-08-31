import type { LocalLayer } from "../doc-model.js";
import type { UiState } from "./store.js";

/**
 * What survives of the selection target when the document changes underneath
 * it (spec §3.6).
 *
 * The target is long-lived state; the document is not. Nothing invalidated it
 * before, so both axes could silently point at things that no longer exist or
 * have moved — never a crash, always a wrong result, which is the worst shape
 * a bug can have. Returns ONLY the keys that actually change, so an unrelated
 * doc update does not hand React a fresh `selection` array for nothing.
 */
export function invalidateTarget(
  prev: Pick<UiState, "doc" | "selection" | "region">,
  next: { canvas: { width: number; height: number }; layers: LocalLayer[] },
  fresh: boolean,
): Partial<UiState> {
  const patch: Partial<UiState> = {};

  // A different document entirely: nothing about the old target means
  // anything here, and layer ids from the previous file would otherwise be
  // carried straight over.
  if (fresh) {
    if (prev.selection.length > 0) patch.selection = [];
    if (prev.region) patch.region = null;
    return patch;
  }

  // A canvas resize is a crop (or an agent resize): the region's coordinate
  // system is gone. Clearing is more honest than remapping — the user just
  // cropped the canvas DOWN TO that region, so re-selecting "where it now
  // sits" would be a tautology.
  const sized = prev.doc?.canvas;
  if (prev.region && sized && (sized.width !== next.canvas.width || sized.height !== next.canvas.height)) {
    patch.region = null;
  }

  // Layers can vanish under us (a local delete, or an agent run). Prune the
  // dead ids rather than dropping the whole selection — losing four
  // selections because the agent deleted a fifth layer is its own bug.
  if (prev.selection.length > 0) {
    const alive = new Set<string>();
    const walk = (list: LocalLayer[]): void => {
      for (const l of list) { alive.add(l.id); if (l.children) walk(l.children); }
    };
    walk(next.layers);
    const kept = prev.selection.filter((id) => alive.has(id));
    if (kept.length !== prev.selection.length) patch.selection = kept;
  }

  return patch;
}
