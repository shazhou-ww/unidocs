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
import { editPixelsInstructions, instructions, setTextInstructions, textRoutingInstructions, tools } from "./tools.js";
import { createEditPixelsTool } from "./image/edit-pixels.js";
import type { ImageEditor } from "./image/editor.js";
import { createSetTextTool, type FontIndexSource } from "./text/set-text.js";
import type { PsdOp } from "./ops/index.js";
import type { PsdQuery } from "./queries.js";

export interface PsdAgentDeps {
  /** 缺省时工具表里没有 editPixels。 */
  readonly editor?: ImageEditor;
  /**
   * 缺省时工具表里没有 setText。
   *
   * 判据就是"有没有字体可用"：setText 要把文字重新排版、重新栅格化，没有
   * 字体索引它连一个字形都拿不到，注册进去只会让模型调一次、失败一次。
   * 与 editor 同一套先例：没有手的 agent 不该在工具表里宣称自己能画。
   * 来源是租户级的字体索引 DO，由 worker 按 PSD_FONTS 绑定注入；绑定缺失
   * （只可能是漏配）时这里缺省，工具表里也就没有 setText。
   */
  readonly fontIndex?: FontIndexSource;
}

export function createPsdAgent(deps: PsdAgentDeps): DocumentAgent<PsdQuery, PsdOp> {
  // 工具表和提示词必须一起条件化。只条件化其中一个，就会得到一个
  // "提示词里有、工具表里没有"的幽灵工具 —— 模型会去找它，找不到，然后
  // 向用户道歉。这是线上真实发生过的一次故障。所以每个条件工具的注册与
  // 它的说明块都写在**同一个 if 里**，不许拆开。
  const enabled = [...tools];
  let prompt = instructions;
  if (deps.editor) {
    enabled.push(createEditPixelsTool(deps.editor));
    prompt += editPixelsInstructions;
  }
  if (deps.fontIndex) {
    enabled.push(createSetTextTool(deps.fontIndex));
    prompt += setTextInstructions;
  }
  // 分流规则点名了两个工具，所以它的条件就是两个工具都在场 —— 同一条
  // "工具表与提示词一起条件化"的规矩，只是这一块的前提是两个 if 的交集。
  // 少了任何一个就没有可分的流，基础提示词里那条不点名工具的规则接管。
  if (deps.editor && deps.fontIndex) prompt += textRoutingInstructions;
  return { tools: enabled, instructions: prompt };
}
