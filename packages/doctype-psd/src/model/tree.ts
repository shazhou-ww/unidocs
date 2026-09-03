import type { Layer } from "./types.js";

export function findLayer(layers: Layer[], id: string): Layer | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLayer(l.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function findParentList(layers: Layer[], id: string): { list: Layer[]; index: number } | undefined {
  const i = layers.findIndex((l) => l.id === id);
  if (i !== -1) return { list: layers, index: i };
  for (const l of layers) {
    if (l.children) {
      const found = findParentList(l.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function removeById(layers: Layer[], id: string): Layer | undefined {
  const p = findParentList(layers, id);
  if (!p) return undefined;
  return p.list.splice(p.index, 1)[0];
}

export function insertAt(list: Layer[], layer: Layer, index?: number): void {
  if (index === undefined || index >= list.length) list.push(layer);
  else list.splice(Math.max(0, index), 0, layer);
}

export function isDescendant(root: Layer, id: string): boolean {
  if (!root.children) return false;
  return root.children.some((c) => c.id === id || isDescendant(c, id));
}

/** 某层所在组的 id；在根列表里则是 null。找不到该层也返回 null。 */
export function findParentId(layers: Layer[], id: string): string | null {
  const walk = (list: Layer[], parent: string | null): string | null | undefined => {
    for (const l of list) {
      if (l.id === id) return parent;
      if (l.children) {
        const hit = walk(l.children, l.id);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  return walk(layers, null) ?? null;
}
