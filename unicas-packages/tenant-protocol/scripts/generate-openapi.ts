import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { generateTenantOpenApiDocument } from "./openapi.js";

const document = await generateTenantOpenApiDocument();
const jsonPath = resolve(process.cwd(), "openapi/tenant-v1.openapi.json");

await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
process.stdout.write(`Generated ${relative(process.cwd(), jsonPath)}\n`);