import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { renderTenantApiReferenceHtml } from "./html.js";
import { generateTenantOpenApiDocument } from "./openapi.js";

const document = await generateTenantOpenApiDocument();
const jsonPath = resolve(process.cwd(), "openapi/tenant-v1.openapi.json");
const htmlPath = resolve(process.cwd(), "openapi/tenant-v1.html");

await Promise.all([
  mkdir(dirname(jsonPath), { recursive: true }),
  mkdir(dirname(htmlPath), { recursive: true }),
]);
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8"),
  writeFile(htmlPath, renderTenantApiReferenceHtml(document), "utf8"),
]);
process.stdout.write([
  `Generated ${relative(process.cwd(), jsonPath)}`,
  `Generated ${relative(process.cwd(), htmlPath)}`,
  "",
].join("\n"));