import type { OpenAPI } from "@orpc/openapi";
import { AdminApiOperationOrder, AdminApiTagGroups } from "./openapi.js";

const ScalarApiReferenceVersion = "1.68.0";

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderAdminApiReferenceHtml(document: OpenAPI.Document): string {
  const content = serializeForInlineScript(document);
  const tagOrder = serializeForInlineScript(AdminApiTagGroups.flatMap((group) => group.tags));
  const operationOrder = serializeForInlineScript(AdminApiOperationOrder);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>UniCAS Administrator API</title>
  <style>html, body, #app { height: 100%; margin: 0; } body { background: #fff; }</style>
</head>
<body>
  <div id="app"></div>
  <noscript>JavaScript is required to render the UniCAS Administrator API reference.</noscript>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${ScalarApiReferenceVersion}"></script>
  <script>
    const tagOrder = new Map(${tagOrder}.map((name, index) => [name, index]))
    const operationOrder = new Map(${operationOrder}.map((key, index) => [key, index]))
    Scalar.createApiReference('#app', {
      content: ${content},
      layout: 'modern',
      theme: 'default',
      pageTitle: 'UniCAS Administrator API',
      tagsSorter: (a, b) => (tagOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (tagOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER),
      operationsSorter: (a, b) => {
        const keyA = a.method.toUpperCase() + ' ' + a.path
        const keyB = b.method.toUpperCase() + ' ' + b.path
        return (operationOrder.get(keyA) ?? Number.MAX_SAFE_INTEGER) - (operationOrder.get(keyB) ?? Number.MAX_SAFE_INTEGER)
      },
      orderSchemaPropertiesBy: 'preserve',
      modelsSectionLabel: 'Schemas'
    })
  </script>
</body>
</html>
`;
}