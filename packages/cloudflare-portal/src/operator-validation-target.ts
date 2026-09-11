import { createBoundOperatorTransport } from "./operator-transport.js";

export const MARKDOWN_OPERATOR_BASE_URL = "https://unidocs-markdown.shazhou.workers.dev";

function decodeKey(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
}

export function createMarkdownOperatorValidationTarget(service: Fetcher, keyText: string) {
  const key = decodeKey(keyText);
  if (!key) throw new TypeError("Markdown Operator validation is not configured");
  return {
    transport: createBoundOperatorTransport([{
      baseUrl: MARKDOWN_OPERATOR_BASE_URL,
      probePath: "/operator/probe",
      service,
    }]),
    keys: {
      async resolve(baseUrl: string) {
        return baseUrl === MARKDOWN_OPERATOR_BASE_URL ? key : null;
      },
    },
  };
}