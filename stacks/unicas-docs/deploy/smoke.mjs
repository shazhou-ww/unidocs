const baseUrl = new URL(process.argv[2] ?? "https://unicas-docs.shazhou.work");

async function requireOk(path) {
  const response = await fetch(new URL(path, baseUrl), { redirect: "error" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response;
}

const home = await requireOk("/");
const html = await home.text();
if (!html.includes("UniCAS Documentation") || !html.includes('id="root"')) {
  throw new Error("Home page is not the UniCAS documentation shell");
}

const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
if (!assetPath) throw new Error("Home page does not reference a built asset");
await requireOk(assetPath);

const deepLink = await requireOk("/reference/admin");
const deepHtml = await deepLink.text();
if (!deepHtml.includes("UniCAS Documentation")) {
  throw new Error("SPA fallback did not serve the documentation shell for /reference/admin");
}

console.log(`UniCAS docs smoke passed: ${baseUrl.origin}`);
