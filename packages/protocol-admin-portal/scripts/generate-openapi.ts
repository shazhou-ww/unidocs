import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { generateAdminOpenApiDocument } from "./openapi.js";

const document = await generateAdminOpenApiDocument();
const jsonPath = resolve(process.cwd(), "openapi/admin-v1.openapi.json");

await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
process.stdout.write(`Generated ${relative(process.cwd(), jsonPath)}\n`);
