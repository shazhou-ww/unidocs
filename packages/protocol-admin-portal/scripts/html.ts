import type { OpenAPI } from "@orpc/openapi";

const ScalarApiReferenceVersion = "1.68.0";

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderAdminApiReferenceHtml(document: OpenAPI.Document): string {
  const content = serializeForInlineScript(document);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>UniDocs Administrator API</title>
  <style>
    html, body, #app { height: 100%; margin: 0; }
    body { background: #fff; }
  </style>
</head>
<body>
  <div id="app"></div>
  <noscript>JavaScript is required to render the UniDocs Administrator API reference.</noscript>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${ScalarApiReferenceVersion}"></script>
  <script>
    Scalar.createApiReference('#app', {
      content: ${content},
      layout: 'modern',
      theme: 'default',
      authentication: {
        preferredSecurityScheme: 'adminBearer'
      },
      pageTitle: 'UniDocs Administrator API'
    })
  </script>
</body>
</html>
`;
}