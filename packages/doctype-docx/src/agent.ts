/**
 * DOCX DocumentAgent — a plain data table of tools plus a system prompt.
 *
 * Same shape as doctype-psd (see ../doctype-psd/src/agent.ts): each tool
 * declares whether it reads or writes, and the kernel (AgentSession) is the
 * only thing that ever calls the platform (spec 5.1). DOCX doesn't know what
 * an LLM provider or a CAS looks like — it only produces queries/ops from
 * arguments and, for getImage, turns a query result into an image content
 * part.
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import { instructions, tools } from "./tools.js";
import type { DocxOperation, DocxQuery } from "./types.js";

export const docxAgent: DocumentAgent<DocxQuery, DocxOperation> = { tools, instructions };
