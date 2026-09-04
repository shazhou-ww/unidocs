/**
 * `AgentPlatform` 的 HTTP 实现（两条运行时共用） —— 内核唯一能碰到文档的那一面。
 *
 * 全部工作是把内核的四个调用翻译成对编辑器 DO 的内部 HTTP 请求，并把转发头
 * （身份 + capability）原样带过去。它不认识工具、不认识循环，也不记版本。
 */
import { decodeSValue, encodeSValue, isSBlob, toJsonValue } from "@unidocs/svalue-codec";
// BlobUnavailableError 和 AgentPlatform 定义在同一处 —— 它是 readBlob 的
// 错误分类契约，履行契约要用到它。
import { BlobUnavailableError, SValueContentType } from "@unidocs/protocol";
import type { AgentPlatform, SBlob, SBlobBytes, SBlobData, SValue, SValueType } from "@unidocs/protocol";

/**
 * 编辑器的最小可调用面。
 *
 * Cloudflare 传 `DurableObjectStub`（结构上就是这个签名，原样传即可）；
 * Azure 传一层包住 `LocalNamespace` 的适配器。这个 interface 存在的唯一
 * 目的，就是让这 170 行不必认识 `DurableObjectStub`，从而离开 cloudflare-sdk。
 */
export interface EditorFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface HttpAgentPlatformDeps<TEnv> {
  readonly env: TEnv;
  readonly getEditorStub: (
    env: TEnv,
    editorObjectName: string,
  ) => EditorFetcher;
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

export function createHttpAgentPlatform<TQuery, TOp, TEnv>(
  deps: HttpAgentPlatformDeps<TEnv>,
): AgentPlatform<TQuery, TOp> {
  /** 转发头 + 目标 stub —— 下面两个发送函数共用这一段。 */
  function editorTarget(): { headers: Headers; stub: EditorFetcher } {
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

    async writeBlob(data: SBlobBytes): Promise<SBlob> {
      // 请求体是裸字节而不是 SValue 信封：这条路上的净荷就是一张 PNG，
      // 再包一层 SValue 只会把它复制一遍（一个整层 PNG 可以是几 MB）。
      // 响应仍走 SValue，因为回来的 SBlob 是个带签名的分支类型。
      const { headers, stub } = editorTarget();
      headers.set("Content-Type", data.contentType);
      headers.set("Accept", SValueContentType);
      const response = await stub.fetch("http://editor/_internal/write_blob", {
        method: "POST",
        headers,
        body: Uint8Array.from(data.data).buffer,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Editor write blob failed ${response.status}: ${detail || response.statusText}`);
      }
      const value = await decodeValueResponse(response);
      if (!isRecord(value) || !isSBlob(value.blob)) {
        throw new Error("Editor write blob response has no blob");
      }
      return value.blob;
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
