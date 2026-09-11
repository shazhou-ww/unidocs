const baseUrl = new URL(process.argv[2] ?? "https://docs.shazhou.work");

async function requireOk(path) {
  const response = await fetch(new URL(path, baseUrl), { redirect: "error" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response;
}

const unicasHome = await requireOk("/unicas");
const html = await unicasHome.text();
if (!html.includes("Product Documentation") || !html.includes('id="root"')) {
  throw new Error("UniCAS home page is not the documentation shell");
}

const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
if (!assetPath) throw new Error("Home page does not reference a built asset");
await requireOk(assetPath);

const unicasReference = await requireOk("/unicas/reference/admin");
const unicasReferenceHtml = await unicasReference.text();
if (!unicasReferenceHtml.includes("Product Documentation")) {
  throw new Error("SPA fallback did not serve the documentation shell for /unicas/reference/admin");
}

const unidocsHome = await requireOk("/unidocs");
const unidocsHomeHtml = await unidocsHome.text();
if (!unidocsHomeHtml.includes("Product Documentation")) {
  throw new Error("SPA fallback did not serve the documentation shell for /unidocs");
}

const unidocsReference = await requireOk("/unidocs/reference/admin");
const unidocsReferenceHtml = await unidocsReference.text();
if (!unidocsReferenceHtml.includes("Product Documentation")) {
  throw new Error("SPA fallback did not serve the documentation shell for /unidocs/reference/admin");
}

console.log(`Documentation portal smoke passed: ${baseUrl.origin}/unicas and ${baseUrl.origin}/unidocs`);
