import { parseTree, type Node, type ParseError } from "jsonc-parser";

export function parseStrictJson(content: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!root || errors.length) throw new TypeError("Invalid JSON");
  function inspect(node: Node, depth: number): void {
    if (depth > 64) throw new TypeError("JSON nesting exceeds limit");
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key: unknown = property.children?.[0]?.value;
        if (typeof key !== "string" || keys.has(key)) throw new TypeError("Duplicate JSON key");
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) inspect(child, depth + 1);
  }
  inspect(root, 0);
  return JSON.parse(text);
}