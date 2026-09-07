/**
 * Cloudflare Worker entry point for the PSD image document type.
 *
 * Exports three Durable Object classes (PsdEditor, PsdOperator, PsdFonts) that
 * the Gateway forwards to via HTTP. Routing (path parsing, method dispatch,
 * header injection) is inline here, mirroring the docx/markdown workers — see
 * the docx worker for the URL contract.
 *
 * PsdFonts 是**租户级**的（其余两个是会话级），所以它的路径
 * `/tenants/{t}/fonts` 在 fetch 里先分流，不走 `createDocTypeHandler` ——
 * 后者只认会话级路径。见 fonts-do.ts。
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

import {
  createEditorDO,
  createOperatorDO,
  type AgentIdentity,
  type EditorEnv,
} from "@unidocs/cloudflare-sdk";
import { createPsdDocumentType, createPsdAgent } from "@unidocs/doctype-psd";
import {
  createDocTypeHandler,
  DocAuthConfigCache,
  handleFontsRequest,
  type DocAuthBindings,
} from "@unidocs/doctype-server-common";
import { createAnthropicProvider } from "@unidocs/doctype-server-common/agent";
import { consoleObserver, matchFontsRoute } from "@unidocs/protocol-doc";
import { createDoFontRegistry } from "./font-registry-do.js";
import { fontsObjectName, PsdFontsDurableObject } from "./fonts-do.js";
import { psdAgentDeps, type PsdAgentEnv } from "./agent-deps.js";

const psdFactory = createPsdDocumentType;
const authConfig = new DocAuthConfigCache("psd");

export const PsdEditor = createEditorDO(psdFactory);
export const PsdFonts = PsdFontsDurableObject;

export const PsdOperator = createOperatorDO({
  // 接线本体在 ./agent-deps.ts：这个文件顶层有 createEditorDO /
  // createOperatorDO / export default 这些副作用，想 import 接线的人不该被迫
  // 连带执行它们。判据（没 key 就没 editor、没 PSD_FONTS 绑定就没 fontIndex）
  // 与它们的由来都记在那边。
  agent: (env: Env, identity: AgentIdentity) => createPsdAgent(psdAgentDeps(env, identity)),
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

// PSD_FONTS / PSD_FONT_FALLBACKS / IMAGE_EDIT_* 由 PsdAgentEnv 声明（连同它们
// 各自"缺了会怎样"的注释）——接线读的就是那几个，两处各写一份迟早漂移。
interface Env extends EditorEnv, DocAuthBindings, PsdAgentEnv {
  PSD_EDITOR: DurableObjectNamespace;
  PSD_OPERATOR: DurableObjectNamespace;
  // Operator LLM config — see the Anthropic provider in
  // @unidocs/doctype-server-common/agent and .dev.vars.example.
  // Absent in deployments that never run the chatbox; the provider throws a
  // clear error on the first /run instead of at construction time.
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = await authConfig.get(env);
    // 租户级端点必须在这里先分流：`matchDocRoute` 把路径硬编码成
    // `/tenants/{t}/sessions/{s}[/{op}]`，`/tenants/{t}/fonts` 不匹配，交给
    // `createDocTypeHandler` 只会得到 404 Unknown Doc endpoint。
    const fonts = matchFontsRoute(new URL(request.url).pathname);
    if (fonts) {
      if (!env.PSD_FONTS) {
        return Response.json({ error: "Fonts index is not configured" }, { status: 501 });
      }
      // 中立的 handleFontsRequest 不兜底存储层的异常（registry.list/put 抛出
      // 就直接 reject 出去）—— 原先 PsdFontsDurableObject.fetch 自己的 try/catch
      // 把这类故障变成 500，这一层责任现在落在这里，不然一次存储故障会变成
      // 未处理拒绝，而不是一个像样的 500。
      try {
        return await handleFontsRequest({
          docCapabilityVerifier: auth.docCapabilityVerifier,
          registry: createDoFontRegistry({
            namespace: env.PSD_FONTS,
            objectName: fontsObjectName({ stackId: env.CAS_STACK_ID, tenantId: fonts.tenantId }),
          }),
          audit: event => console.log(JSON.stringify({
            event: "doc_authentication",
            docType: "psd",
            ...event,
          })),
        }, request, fonts);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    return createDocTypeHandler({
      docType: "psd",
      ...auth,
      audit: event => console.log(JSON.stringify({ event: "doc_authentication", docType: "psd", ...event })),
      editor: env.PSD_EDITOR,
      operator: env.PSD_OPERATOR,
    })(request);
  },
};
