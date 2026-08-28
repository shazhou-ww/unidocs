/**
 * `AgentPlatform` 的 Cloudflare 实现 —— 内核唯一能碰到文档的那一面。
 *
 * 全部工作是把内核的四个调用翻译成对编辑器 DO 的内部 HTTP 请求，并把转发头
 * （身份 + capability）原样带过去。它不认识工具、不认识循环，也不记版本。
 */
import { decodeSValue, encodeSValue, isSBlob, toJsonValue } from "@unidocs/svalue-codec";
import { SValueContentType } from "@unidocs/protocol";
import type { AgentPlatform, SBlob, SBlobData, SValue, SValueType } from "@unidocs/protocol";
import { BlobUnavailableError } from "@unidocs/doctype-server-common/agent";

export interface CloudflarePlatformDeps<TEnv> {
  readonly env: TEnv;
  readonly getEditorStub: (
    env: TEnv,
    editorObjectName: string,
  ) => DurableObjectStub;
  /**
   * 从入站请求捕获的转发头（身份 + capability），见 operator-do-agent.ts 的
   * `#captureIdentity`。
   *
   * 是取当前值的函数，不是构造时定死的一份：一个 AgentSession 跨多次 /run
   * 存活，而这些头一次请求一换（capability token 会换新的）。
   */
  readonly requestHeaders: () => Headers;
  /** 目标编辑器 DO 的对象名，同样按当次请求的 auth 模式解析。 */
  readonly editorObjectName: () => string;
}

export function createCloudflareAgentPlatform<TQuery, TOp, TEnv>(
  deps: CloudflarePlatformDeps<TEnv>,
): AgentPlatform<TQuery, TOp> {
  /** 转发头 + 目标 stub —— 下面两个发送函数共用这一段。 */
  function editorTarget(): { headers: Headers; stub: DurableObjectStub } {
    return {
      headers: new Headers(deps.requestHeaders()),
      stub: deps.getEditorStub(deps.env, deps.editorObjectName()),
    };
  }

  /** 无请求体的变体：同一套转发头，方法可变，不发 body。 */
  function editorRequest(method: string, path: string): Promise<Response> {
    const { headers, stub } = editorTarget();
    return stub.fetch(`http://editor${path}`, { method, headers });
  }

  function editorValueRequest(path: string, value: SValue): Promise<Response> {
    const { headers, stub } = editorTarget();
    headers.set("Content-Type", SValueContentType);
    headers.set("Accept", SValueContentType);
    const bytes = encodeSValue(value);
    return stub.fetch(`http://editor${path}`, {
      method: "POST",
      headers,
      body: Uint8Array.from(bytes).buffer,
    });
  }

  /**
   * 当前 head 版本。走已有的 `GET /_internal/status`（editor-do-svalue.ts
   * 的 `{ exists, version }`），与文档类型无关，不需要为 agent 新开路由。
   */
  async function headVersion(): Promise<number> {
    const response = await editorRequest("GET", "/_internal/status");
    const value = await response.json() as { exists?: unknown; version?: unknown };
    if (!response.ok || typeof value.version !== "number") {
      throw new Error(`Editor status failed: ${response.status}`);
    }
    if (value.exists !== true) throw new Error("Document not initialized");
    return value.version;
  }

  return {
    async query(query: SValueType<TQuery>): Promise<{ data: SValue; version: number }> {
      const response = await editorValueRequest("/_internal/query", query as unknown as SValue);
      const value = await decodeValueResponse(response);
      if (!response.ok || !isRecord(value) || value.success !== true || typeof value.version !== "number") {
        throw editorError("query", value);
      }
      if (!("data" in value)) throw new Error("Editor query response has no data");
      return { data: value.data, version: value.version };
    },

    async apply(
      operations: readonly SValueType<TOp>[],
      description: string,
    ): Promise<{ version: number }> {
      // agent 的职责到"生成 op"为止 —— baseVersion 是编辑器写入路径的必需
      // 参数（editor-do-svalue.ts 缺了它直接 400），由这里读当前 head 得到，
      // 而不是由循环记着上次 query 看到的版本（spec 5.2.1）。
      //
      // 代价是每次 apply 多一次轻量往返。之所以不让编辑器接受"不带
      // baseVersion 即用当前 head"，是因为那会给它开一条绕过版本校验的路径，
      // 影响的不只是 agent。真成为瓶颈时再单独讨论。
      const head = await headVersion();
      const response = await editorValueRequest("/_internal/apply", {
        operations: operations as unknown as readonly SValue[],
        description,
        baseVersion: head,
      });
      const value = await response.json() as {
        success?: unknown;
        version?: unknown;
        error?: unknown;
      };
      if (!response.ok || value.success !== true || typeof value.version !== "number") {
        throw new Error(`Editor apply failed: ${String(value.error ?? response.statusText)}`);
      }
      return { version: value.version };
    },

    async readBlob(blob: SBlob): Promise<SBlobData> {
      const response = await editorValueRequest("/_internal/read_blob", { blob });
      if (response.status === 404) {
        // 只有"确实没了"才让内核降级成文字。401 / 403 / 5xx 一律往上抛 ——
        // 把它们伪装成"图没了"正是提交 63f997b 修掉的坑。
        throw new BlobUnavailableError(`blob ${blob.hash} is gone`);
      }
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Editor read blob failed ${response.status}: ${error || response.statusText}`);
      }
      const contentType = response.headers.get("Content-Type");
      if (!contentType) throw new Error("Editor blob response has no Content-Type");
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType,
      };
    },

    async writeBlob(): Promise<SBlob> {
      // 第一个调用方要等到 provider 真的返回图片或文件字节（spec 5.4.2）。
      // 那时给编辑器加一条 /_internal/write_blob，让它走 ctx.makeSBlob(data)
      // ——今天 editor-do-svalue.ts 只有 resolve_blob（按 hash 造引用）和
      // read_blob（读字节），没有"给我字节、返回 SBlob"那一条。
      throw new Error("writeBlob is not wired yet: no provider returns binary content");
    },
  };
}

async function decodeValueResponse(response: Response): Promise<SValue> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.toLowerCase() === SValueContentType) {
    return decodeSValue(new Uint8Array(await response.arrayBuffer()));
  }
  return toJsonValue(await response.json() as SValue);
}

function isRecord(value: SValue): value is { readonly [key: string]: SValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isSBlob(value);
}

function editorError(operation: string, value: SValue): Error {
  const message = isRecord(value) && typeof value.error === "string"
    ? value.error
    : JSON.stringify(toJsonValue(value));
  return new Error(`Editor ${operation} failed: ${message}`);
}
