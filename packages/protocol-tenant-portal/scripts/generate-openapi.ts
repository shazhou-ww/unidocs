import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { renderTenantApiReferenceHtml } from "./html.js";
import { zhTenantApiTranslation } from "./locales/zh.js";
import { localizeDocument } from "./localize.js";
import { generateTenantOpenApiDocument } from "./openapi.js";

const english = await generateTenantOpenApiDocument();
const documents = {
  en: english,
  zh: localizeDocument(english, zhTenantApiTranslation),
};

const outputs = [
  ["openapi/tenant-v1.openapi.json", `${JSON.stringify(documents.en, null, 2)}\n`],
  ["openapi/tenant-v1.zh.openapi.json", `${JSON.stringify(documents.zh, null, 2)}\n`],
  ["openapi/tenant-v1.html", renderTenantApiReferenceHtml(documents)],
] as const;

const paths = outputs.map(([name]) => resolve(process.cwd(), name));
await Promise.all([...new Set(paths.map(dirname))].map((dir) => mkdir(dir, { recursive: true })));
await Promise.all(outputs.map(([, body], index) => writeFile(paths[index]!, body, "utf8")));

process.stdout.write([
  ...paths.map((path) => `Generated ${relative(process.cwd(), path)}`),
  "",
].join("\n"));
