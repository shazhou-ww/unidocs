import type { PsdDoc, Layer } from "./model/types.js";
import type { QueryValue } from "@unidocs/core";

export type PsdQuery =
  | { kind: "getLayers"; payload?: Record<string, never> }
  | { kind: "getPreview"; payload?: { scale?: number } };

function summarize(l: Layer): any {
  return {
    id: l.id, type: l.type, name: l.name, opacity: l.opacity, blendMode: l.blendMode,
    visible: l.visible, bounds: l.bounds,
    ...(l.children ? { children: l.children.map(summarize) } : {}),
  };
}

export async function runQuery(q: PsdQuery, doc: PsdDoc): Promise<QueryValue> {
  switch (q.kind) {
    case "getLayers":
      return doc.layers.map(summarize);
    case "getPreview":
      throw new Error("getPreview: render not implemented yet (see render plan)");
  }
}
