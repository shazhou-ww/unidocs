import type { PsdDoc, Layer } from "./model/types.js";
import type { QueryValue } from "@unidocs/core";
import { encode } from "fast-png";
import { render } from "./render/index.js";

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
    case "getPreview": {
      const px = render(doc);
      return encode({ width: px.width, height: px.height, data: px.data, channels: 4, depth: 8 });
    }
  }
}
