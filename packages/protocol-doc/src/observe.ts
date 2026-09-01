/**
 * HTTP 调用可观测性的共享契约。
 *
 * 一次 HTTP 调用产出一条 `HttpCallEvent`,两个方向都记:
 *   - `dir: "in"`  —— 我们对外提供的接口(网关是唯一外部入口)
 *   - `dir: "out"` —— 我们调用别人的接口(CAS、doc worker)
 *
 * 详略分级(见 `httpCallEvent`):
 *   - 2xx        只记简报:target/op/status/durationMs
 *   - 4xx / 5xx  额外记 url、请求头白名单、响应体前 2KB
 *   - 无响应     status 记 0 并带 error —— 超时、连接被切、抛异常都落在这里,
 *                浏览器侧看到的 `Failed to fetch` 在服务端就是这一条
 *
 * 这里只产出事件,不决定往哪写:`ObserveFn` 由适配器注入(默认 `consoleObserver`
 * 打一行 JSON 到 stdout,workerd 与 Node 都支持)。因此本模块保持 cloud-neutral
 * 且可测 —— 测试注入一个收集器即可断言事件序列。
 */

/** 响应体片段的字节上限。错误响应通常是小 JSON;截断是为了防某个上游吐一个
 *  巨大的 HTML 错误页把日志刷爆。 */
export const ObservedBodyCap = 2048;

/**
 * 允许记录的请求头。**白名单而非黑名单** —— 黑名单迟早会漏掉一个新加的凭据头。
 * `Authorization` / `X-UniDocs-CAS-Capability` / `X-Internal-Token` / Cookie
 * 都携带能力票或令牌,永远不记。
 */
export const ObservedHeaderAllowlist: readonly string[] = [
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
  "user-agent",
];

export interface HttpCallEvent {
  readonly event: "http_call";
  /** "in" = 我们提供的接口;"out" = 我们调用的接口。 */
  readonly dir: "in" | "out";
  /** 调用对象。入站恒为 "gateway";出站是 "cas" 或 `doc:${docType}`。 */
  readonly target: string;
  /** 逻辑操作名(createDocument / lease / …),便于按接口聚合。 */
  readonly op?: string;
  readonly method: string;
  /** HTTP 状态码;**0 表示根本没拿到响应**(超时/连接断/抛异常)。 */
  readonly status: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly tenantId?: string;
  readonly docType?: string;
  /** 以下仅在非 2xx 时出现。 */
  readonly url?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly responseBody?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

export type ObserveFn = (event: HttpCallEvent) => void;

/** 默认落地方式:一行 JSON 到 stdout。Container Apps 会把它收进
 *  Log Analytics 的 ContainerAppConsoleLogs_CL,Workers 收进 tail。 */
export const consoleObserver: ObserveFn = (event) => {
  console.log(JSON.stringify(event));
};

/** 什么都不做的 observer,给不关心可观测性的调用方(和大部分单测)用。 */
export const noopObserver: ObserveFn = () => {};

/** 按白名单挑请求头。缺失的头不会出现在结果里(而不是记成 undefined)。 */
export function pickObservedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ObservedHeaderAllowlist) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** 截断到 `cap` 字节。按 UTF-16 长度截,够用且不会把代理对切一半以外的东西弄坏。 */
export function truncateObservedBody(
  text: string,
  cap: number = ObservedBodyCap,
): { body: string; truncated: boolean } {
  if (text.length <= cap) return { body: text, truncated: false };
  return { body: text.slice(0, cap), truncated: true };
}

/**
 * 读取错误响应体用于日志。
 *
 * **必须传 `response.clone()`** —— 调用方通常要把原响应流式转发出去,直接读会
 * 把流消费掉。只在 status >= 400 时调用:成功响应可能是几十 MB 的文档,克隆并
 * 读取它既昂贵又无意义。
 *
 * 读取本身失败(流已被消费、连接中断)不该让日志把主流程搞崩,所以吞掉异常。
 */
export async function readObservedBody(
  cloned: Response,
  cap: number = ObservedBodyCap,
): Promise<{ responseBody?: string; truncated?: boolean }> {
  try {
    const text = await cloned.text();
    if (text === "") return {};
    const { body, truncated } = truncateObservedBody(text, cap);
    return truncated ? { responseBody: body, truncated } : { responseBody: body };
  } catch {
    return {};
  }
}

export interface HttpCallInput {
  readonly dir: "in" | "out";
  readonly target: string;
  readonly op?: string;
  readonly method: string;
  readonly durationMs: number;
  readonly tenantId?: string;
  readonly docType?: string;
  /** 完整 URL,只在非 2xx 时写进事件。 */
  readonly url?: string;
  readonly requestHeaders?: Record<string, string>;
}

/**
 * 组装一条成功/失败事件。2xx 走简报,其余带上排错细节。
 *
 * `detail` 由调用方在确认状态码 >= 400 之后再去取(见 `readObservedBody`),
 * 这样成功路径上一个字节都不会多读。
 */
export function httpCallEvent(
  input: HttpCallInput,
  status: number,
  detail?: { responseBody?: string; truncated?: boolean; error?: string },
): HttpCallEvent {
  const ok = status >= 200 && status < 300;
  const base = {
    event: "http_call" as const,
    dir: input.dir,
    target: input.target,
    ...(input.op !== undefined ? { op: input.op } : {}),
    method: input.method,
    status,
    durationMs: input.durationMs,
    ok,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    ...(input.docType !== undefined ? { docType: input.docType } : {}),
  };
  if (ok) return base;
  return {
    ...base,
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.requestHeaders !== undefined ? { requestHeaders: input.requestHeaders } : {}),
    ...(detail?.responseBody !== undefined ? { responseBody: detail.responseBody } : {}),
    ...(detail?.truncated ? { truncated: true } : {}),
    ...(detail?.error !== undefined ? { error: detail.error } : {}),
  };
}

/** 没拿到响应时的事件:status 记 0,带上异常 message。 */
export function httpCallFailure(input: HttpCallInput, error: unknown): HttpCallEvent {
  return httpCallEvent(input, 0, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}
