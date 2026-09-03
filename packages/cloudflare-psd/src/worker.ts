/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports two Durable Object classes (PsdEditor, PsdOperator) that the Gateway
 * forwards to via HTTP. Routing (path parsing, method dispatch, header
 * injection) is inline here, mirroring the docx/markdown workers — see the
 * docx worker for the URL contract.
 *
 * The operator (chatbox agent) runs the PSD tool set from @unidocs/doctype-psd
 * against Claude via the Anthropic provider in
 * @unidocs/doctype-server-common/agent. Credentials come from env
 * (LLM_API_KEY / LLM_BASE_URL / LLM_MODEL, or the ANTHROPIC_* aliases): in
 * production from wrangler secrets, in local dev from
 * packages/cloudflare-psd/.dev.vars — `readDevVars` in
 * stacks/unidocs-cloudflare/local/runtime.mjs parses it and `buildWorkers` merges it into this
 * worker's Miniflare bindings.
 */

import { createEditorDO, createOperatorDO, type EditorEnv } from "@unidocs/cloudflare-sdk";
import { createPsdDocumentType, createPsdAgent, createQwenImageEditor } from "@unidocs/doctype-psd";
import {
  createDocTypeHandler,
  DocAuthConfigCache,
  type DocAuthBindings,
} from "@unidocs/doctype-server-common";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { consoleObserver } from "@unidocs/protocol-doc";

const psdFactory = createPsdDocumentType;
const authConfig = new DocAuthConfigCache("psd");

export const PsdEditor = createEditorDO(psdFactory);
export const PsdOperator = createOperatorDO({
  // 按 env 构造：editPixels 需要一个带 API key 的图像模型，而 key 只在
  // 这里拿得到。没配 key 就不注入 editor —— 工具表里也就没有 editPixels，
  // 模型不会去调一个注定失败的工具。
  agent: (env: Env) => createPsdAgent(
    env.IMAGE_EDIT_API_KEY
      ? {
        editor: createQwenImageEditor({
          apiKey: env.IMAGE_EDIT_API_KEY,
          // 系统里唯一的第三方调用。不接观测的话，它出问题时只留下一个
          // 不透明的 500 —— 排查只能靠猜。
          observe: consoleObserver,
          ...(env.IMAGE_EDIT_MODEL ? { model: env.IMAGE_EDIT_MODEL } : {}),
          ...(env.IMAGE_EDIT_BASE_URL ? { baseUrl: env.IMAGE_EDIT_BASE_URL } : {}),
        }),
      }
      : {},
  ),
  // The provider is built from env: a DO instance outlives a config change,
  // and `env` is only handed to us here.
  // 与出站 HTTP、DashScope、agent 循环同一条日志流。补这个观测是因为一次
  // 真实故障：第一轮模型调用挂满 300 秒才被掐断，而日志里连它打去了哪个地址
  // 都看不到 —— 它当时是系统里唯一不产 http_call 的出站调用。
  provider: (env: Env) => createAnthropicProvider(env, fetch, { observe: consoleObserver }),
  getEditorStub: (env: Env, sessionId) => {
    const id = env.PSD_EDITOR.idFromName(sessionId);
    return env.PSD_EDITOR.get(id);
  },
  // 有了 editPixels，一次层内重绘从"无路可走、烧满 25 轮"变成 2~3 轮。
  // 上限暂时保持 25：多图层、多步骤的指令仍然吃得下。
  maxIterations: 25,
});

interface Env extends EditorEnv, DocAuthBindings {
  PSD_EDITOR: DurableObjectNamespace;
  PSD_OPERATOR: DurableObjectNamespace;
  // Operator LLM config — see the Anthropic provider in
  // @unidocs/doctype-server-common/agent and .dev.vars.example.
  // Absent in deployments that never run the chatbox; the provider throws a
  // clear error on the first /run instead of at construction time.
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  // 图像编辑模型（editPixels）。缺省时 agent 的工具表里没有 editPixels，
  // 层内像素编辑不可用，其余功能不受影响。
  IMAGE_EDIT_API_KEY?: string;
  IMAGE_EDIT_MODEL?: string;
  IMAGE_EDIT_BASE_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return createDocTypeHandler({
      docType: "psd",
      ...(await authConfig.get(env)),
      audit: event => console.log(JSON.stringify({ event: "doc_authentication", docType: "psd", ...event })),
      editor: env.PSD_EDITOR,
      operator: env.PSD_OPERATOR,
    })(request);
  },
};
