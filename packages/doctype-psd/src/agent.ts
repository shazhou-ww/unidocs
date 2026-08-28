/**
 * PSD DocumentAgent — the chatbox/Operator side of the PSD document type.
 *
 * Mirrors the markdown/docx agents: tool names carry a `query_` / `apply_`
 * prefix and the suffix is the query/op `kind`, so dispatch is mechanical.
 *
 * Images: `query_getPreview` returns `{ $image: { base64, mediaType }, width,
 * height, region }` inside the query data. It travels as ordinary
 * structuredContent — the Operator's default renderer JSON-stringifies it and
 * the Anthropic provider (packages/cloudflare-psd/src/anthropic.ts) spots the
 * `$image` payload and re-emits it as a real Claude image block. So no
 * multimodal `content` part (and therefore no provider-specific
 * `renderToolResult`) is needed here; docx's SBlob-based image path is the
 * other convention and does not apply to a freshly rendered PNG.
 */

import { toJsonValue } from "@unidocs/svalue-codec";
import type { LegacyDocumentAgentFactory, JsonValue, SValueType } from "@unidocs/protocol";
import { instructions, tools } from "./tools.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export type PsdDocumentAgentFactory = LegacyDocumentAgentFactory<PsdQuery, PsdOp>;

const toolsByName = new Set(Object.values(tools).map(tool => tool.name));

export const createPsdDocumentAgent: PsdDocumentAgentFactory = context => ({
  tools,
  instructions,

  async toolCall(name, parameters) {
    if (!toolsByName.has(name)) throw new Error(`Unknown PSD agent tool: ${name}`);
    const args = requireJsonObject(parameters);

    if (name.startsWith("query_")) {
      const kind = name.slice("query_".length);
      // Every PSD query has an optional payload; omit it entirely when the
      // model passed no arguments so `{}` never masks a default.
      const query = Object.keys(args).length === 0
        ? { kind }
        : { kind, payload: args };
      const result = await context.query(query as unknown as PsdQuery);
      return {
        structuredContent: toJsonValue({
          data: result.data,
          version: result.version,
        }),
      };
    }

    if (name.startsWith("apply_")) {
      const operation = {
        kind: name.slice("apply_".length),
        payload: args,
      };
      // PsdOp.payload is Record<string, unknown>, so SValueType<PsdOp>
      // collapses to `never`; doctype.ts widens the same way for its
      // DocumentType. The value here really is a JSON object.
      const result = await context.apply(
        [operation] as unknown as readonly SValueType<PsdOp>[],
        `Agent: ${name}`,
      );
      return {
        structuredContent: {
          success: true,
          version: result.version,
        },
      };
    }

    throw new Error(`Unsupported PSD agent tool: ${name}`);
  },
});

function requireJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent tool parameters must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}
