/**
 * PSD image DocumentType for UniDocs.
 *
 * Design: ./docs/design.md (v0.3). This is the cloud-neutral document type;
 * the Cloudflare adapter lives in ./worker.ts.
 *
 * STATUS: scaffold. `load`/`save`/`apply`/`query` are stubs pending the
 * DO-runtime spike (can ag-psd + pixel decode run in Workers? — design §9).
 */

import type { DocumentTypeFactory } from "@unidocs/core";

// ── Document model (design §1–§4) ──────────────────────────────────────────

export interface Canvas {
  width: number;
  height: number;
  colorMode: "RGB"; // MVP: RGB only (design §6)
  depth: 8; // MVP: 8-bit only
  resolution: number;
  profile: string;
}

export interface Layer {
  id: string;
  type: "raster" | "adjustment" | "fill" | "text" | "smartObject" | "group";
  name: string;
  bounds: [number, number, number, number]; // [top, left, bottom, right]
  opacity: number; // 0.0–1.0
  blendMode: string; // readable name, mapped to PSD key on save (design §4)
  visible: boolean;
  locked: boolean;
  clipping: boolean;
  pixels?: unknown | null; // design §3.5 (inline bytes for MVP)
  mask?: unknown | null; // design §3.3
  children?: Layer[]; // groups only
  [key: string]: unknown;
}

/** The DocumentType `TDoc`. */
export interface PsdDoc {
  canvas: Canvas;
  layers: Layer[];
}

/** The DocumentType `TQuery` — `{ kind, payload }`. */
export type PsdQuery =
  | { kind: "getLayers"; payload?: Record<string, never> }
  | { kind: "getPreview"; payload?: { scale?: number } };

/** The DocumentType `TOp` — `{ kind, payload }` (design §5). No version/id — the platform owns those. */
export type PsdOp = { kind: string; payload: Record<string, unknown> };

export type PsdOptions = Record<string, never>;
export type PsdDocumentTypeFactory = DocumentTypeFactory<PsdOptions, PsdDoc, PsdQuery, PsdOp>;

const NOT_IMPLEMENTED = "not implemented — see docs/design.md, pending DO-runtime spike";

export const createPsdDocumentType: PsdDocumentTypeFactory = (_options) => ({
  init: async (): Promise<PsdDoc> => ({
    canvas: { width: 0, height: 0, colorMode: "RGB", depth: 8, resolution: 72, profile: "sRGB" },
    layers: [],
  }),

  // ag-psd readPsd({ useImageData, logMissingFeatures, throwForMissingFeatures: false }) → PsdDoc
  load: async (_data: Uint8Array): Promise<PsdDoc> => {
    throw new Error(`load: ${NOT_IMPLEMENTED}`);
  },

  // ag-psd writePsd(PsdDoc → Psd) → bytes. Also used by the platform for snapshots + export.
  save: async (_doc: PsdDoc): Promise<Uint8Array> => {
    throw new Error(`save: ${NOT_IMPLEMENTED}`);
  },

  // Pure, replay-safe. Generative ops must arrive already-resolved (design §5.4).
  apply: async (_operations: readonly PsdOp[], _doc: PsdDoc): Promise<PsdDoc> => {
    throw new Error(`apply: ${NOT_IMPLEMENTED}`);
  },

  query: async (_query: PsdQuery, _doc: PsdDoc) => {
    throw new Error(`query: ${NOT_IMPLEMENTED}`);
  },

  contentType: "image/vnd.adobe.photoshop",

  tools: {
    // apply_* / query_* tools, one per op/query (design §7). To be filled in.
  },

  instructions:
    "You are a PSD image editor operator. (Instructions to be written — design §7.)",
});
