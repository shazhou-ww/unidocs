/**
 * PSD DocumentAgent — a plain data table of tools plus a system prompt.
 *
 * Accepts no handle at all: each tool declares whether it reads or writes,
 * and the kernel (AgentSession) is the only thing that ever calls the
 * platform (spec 5.1). PSD doesn't know what an LLM provider or a CAS
 * looks like — it only produces queries/ops from arguments and, for
 * getPreview, turns a query result into an image content part.
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import { instructions, tools } from "./tools.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export const psdAgent: DocumentAgent<PsdQuery, PsdOp> = { tools, instructions };
