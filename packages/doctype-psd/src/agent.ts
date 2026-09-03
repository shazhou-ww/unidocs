/**
 * PSD DocumentAgent 工厂。
 *
 * 从常量改成工厂，是因为 editPixels 需要一个 ImageEditor —— 一个带
 * API key、会打网络的东西。它按 env 构造，和 operator 里的 provider 同形。
 *
 * 不给 editor 就没有 editPixels：一个连手都没有的 agent 不该在工具表里
 * 宣称自己能画。
 */
import type { DocumentAgent } from "@unidocs/doctype-server-common/agent";
import { editPixelsInstructions, instructions, tools } from "./tools.js";
import { createEditPixelsTool } from "./image/edit-pixels.js";
import type { ImageEditor } from "./image/editor.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export interface PsdAgentDeps {
  /** 缺省时工具表里没有 editPixels。 */
  readonly editor?: ImageEditor;
}

export function createPsdAgent(deps: PsdAgentDeps): DocumentAgent<PsdQuery, PsdOp> {
  // 工具表和提示词必须一起条件化。只条件化其中一个，就会得到一个
  // "提示词里有、工具表里没有"的幽灵工具 —— 模型会去找它，找不到，然后
  // 向用户道歉。这是线上真实发生过的一次故障。
  if (!deps.editor) return { tools, instructions };
  return {
    tools: [...tools, createEditPixelsTool(deps.editor)],
    instructions: instructions + editPixelsInstructions,
  };
}
