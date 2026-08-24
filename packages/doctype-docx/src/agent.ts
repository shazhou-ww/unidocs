import { isSBlob, toJsonValue } from "@unidocs/core";
import type {
  DocumentAgentFactory,
  JsonValue,
  SValue,
} from "@unidocs/core";
import { instructions, tools } from "./tools.js";
import type { DocxOperation, DocxQuery } from "./types.js";

export type DocxDocumentAgentFactory = DocumentAgentFactory<DocxQuery, DocxOperation>;

const toolsByName = new Map(Object.values(tools).map(tool => [tool.name, tool]));

export const createDocxDocumentAgent: DocxDocumentAgentFactory = context => ({
  tools,
  instructions,

  async toolCall(name, parameters) {
    if (!toolsByName.has(name)) throw new Error(`Unknown DOCX agent tool: ${name}`);
    const args = requireJsonObject(parameters);

    if (name.startsWith("query_")) {
      if (name === "query_getImage") {
        return queryImageContent(args, context);
      }
      const kind = name.slice("query_".length);
      const query = Object.keys(args).length === 0
        ? { kind }
        : { kind, payload: args };
      const result = await context.query(query as unknown as DocxQuery);
      return {
        structuredContent: toJsonValue({
          data: result.data,
          version: result.version,
        }),
      };
    }

    if (name.startsWith("apply_")) {
      const kind = name.slice("apply_".length);
      const operation = await makeOperation(kind, args, context.resolveBlob);
      const result = await context.apply([operation], `Agent: ${name}`);
      return {
        structuredContent: {
          success: true,
          version: result.version,
        },
      };
    }

    throw new Error(`Unsupported DOCX agent tool: ${name}`);
  },
});

async function queryImageContent(
  parameters: Readonly<Record<string, JsonValue>>,
  context: Parameters<DocxDocumentAgentFactory>[0],
) {
  const result = await context.query({
    kind: "getImageContent",
    payload: { index: requireNumber(parameters.index, "index") },
  });
  const data = requireSValueRecord(result.data, "Image query result");
  if (!isSBlob(data.blob)) throw new Error("Image query result has no SBlob");
  const { blob, ...metadata } = data;
  const mediaType = metadata.format === "png"
    ? "image/png"
    : metadata.format === "jpeg"
      ? "image/jpeg"
      : null;
  if (mediaType === null) throw new Error(`Unsupported agent image format: ${String(metadata.format)}`);
  const altText = typeof metadata.altText === "string" ? metadata.altText : undefined;
  return {
    structuredContent: toJsonValue({
      data: metadata,
      version: result.version,
    }),
    content: [{
      type: "image" as const,
      blob,
      mediaType,
      ...(altText !== undefined ? { altText } : {}),
    }],
  };
}

async function makeOperation(
  kind: string,
  parameters: Readonly<Record<string, JsonValue>>,
  resolveBlob: (hash: string) => Promise<import("@unidocs/core").SBlob>,
): Promise<DocxOperation> {
  if (kind === "insertImage") {
    const hash = requireString(parameters.hash, "hash");
    return {
      kind: "insertImage",
      payload: {
        blob: await resolveBlob(hash),
        ...(typeof parameters.widthPx === "number" ? { widthPx: parameters.widthPx } : {}),
        ...(typeof parameters.altText === "string" ? { altText: parameters.altText } : {}),
      },
    };
  }
  if (kind === "replaceImage") {
    return {
      kind: "replaceImage",
      payload: {
        index: requireNumber(parameters.index, "index"),
        blob: await resolveBlob(requireString(parameters.hash, "hash")),
      },
    };
  }
  return { kind, payload: parameters } as unknown as DocxOperation;
}

function requireJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Agent tool parameters must be a JSON object");
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function requireString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function requireNumber(value: JsonValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function requireSValueRecord(
  value: SValue,
  name: string,
): Readonly<Record<string, SValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || isSBlob(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Readonly<Record<string, SValue>>;
}