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

/**
 * 上游错误响应体的字节上限。
 *
 * 只在**出站**调用非 2xx 时记,而且刻意压得很小:错误响应通常是一行 JSON,
 * 真正有价值的就是开头那句话(CAS 的 `… the same object. (10058)` 就是这么
 * 被认出来的)。再多就是浪费 —— 上游的 HTML 错误页、堆栈、重复的样板,
 * 对定位没有增量。
 */
export const ObservedBodyCap = 512;

/**
 * 异常栈的字符上限。栈是"拿不到响应"那一档唯一真正有信息量的东西,所以给得
 * 比响应体宽松;但仍要有上限,否则一条深层 async 栈能顶掉整屏日志。
 */
export const ObservedStackCap = 4096;

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
  /**
   * 响应**头**到达的耗时,与 `durationMs`(读完响应体)分开。
   *
   * 两者差得远意味着"对方开始回了但是回得慢",两者一样意味着"对方想了很久
   * 才开口"——这是两种成因、两种修法。只有一个总耗时的时候分不出来。
   * 只在拿到响应且调用方分别计了时的情况下出现。
   */
  readonly ttfbMs?: number;
  readonly ok: boolean;
  readonly tenantId?: string;
  readonly docType?: string;
  /** 以下仅在非 2xx 时出现。 */
  readonly url?: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  /** 仅出站非 2xx。入站不记 —— 那是我们自己合成的错误体,没有增量信息。 */
  readonly responseBody?: string;
  readonly truncated?: boolean;
  /** 异常的 name + message。 */
  readonly error?: string;
  /**
   * 异常栈,仅在 `status: 0`(拿不到响应)时出现。这一档没有上游响应可看,
   * 栈是唯一能说清"卡在我们代码哪一步"的东西 —— 超时是发在建连、写请求体
   * 还是等响应,栈里看得出来。
   */
  readonly stack?: string;
}

/**
 * Agent 一次 run 的生命周期事件。
 *
 * 加这一族是被一次真实故障逼出来的：agent 跑了 64 秒，两次图像调用都成功，
 * 然后整个请求以 `internal error; reference = …` 收场。日志里能看到的只有那
 * 两次出站 HTTP —— 它调了哪些工具、跑了几轮、在第几步崩的、崩在什么上，
 * 一个字都没有。出站 HTTP 有观测，agent 自己没有，这是个洞。
 *
 * 两个事件名，都以 `agent_` 开头，`jq 'select(.event | startswith("agent_"))'`
 * 一条就能把一次 run 完整拉出来：
 *   - `agent_run`  —— 开始与结束各一条，结束那条带上整条调用序列
 *   - `agent_step` —— 每一次模型调用、每一次工具调用各一条
 *
 * 与 `http_call` 同样的详略分级：成功只记简报，失败才带 error 与栈。
 */
export interface AgentRunEvent {
  readonly event: "agent_run";
  readonly phase: "start" | "end";
  readonly docType?: string;
  /** 仅 end。 */
  readonly ok?: boolean;
  readonly iterations?: number;
  readonly durationMs?: number;
  /**
   * 仅 end。整条工具调用序列，连续重复压成 `xN`。
   * 「一直在找图层」和「一直在重画」靠它一眼分开。
   */
  readonly tools?: string;
  /** 仅 end 且失败。 */
  readonly error?: string;
  readonly stack?: string;
}

export interface AgentStepEvent {
  readonly event: "agent_step";
  /** `llm` = 一次模型调用；`tool` = 一次工具调用。 */
  readonly kind: "llm" | "tool";
  /** 第几轮，从 1 起。 */
  readonly iteration: number;
  readonly durationMs: number;
  readonly ok: boolean;
  /** 仅 tool。 */
  readonly name?: string;
  /** 仅 llm：模型这一轮要调的工具名。空数组表示它给出了最终答复。 */
  readonly toolCalls?: readonly string[];
  /** 仅 llm。 */
  readonly stopReason?: string;
  /** 仅失败。 */
  readonly error?: string;
  readonly stack?: string;
}

/**
 * 一次模型调用**发出之前**与**等待期间**的事件。
 *
 * `http_call` 只在调用有结果之后才产出,于是"发出去"到"失败"之间是一段
 * 全黑的区间。一次真实故障就卡在这里:第一轮模型调用挂了 300.3 秒,栈精确
 * 停在 `await fetch(…)` 那一行(响应头始终没到),而那五分钟里日志上一个字
 * 都没有 —— 分不出请求根本没发出去、发出去了对面不回、还是整个 worker 已经
 * 不动了。这三种成因的修法完全不同。
 *
 * 两个 phase 各解决其中一半:
 *   - `start` 在 fetch 之前发,带上**实际发出去的形状**(字节数、消息数、
 *     图片数)。没有它就只能靠猜请求有多大 —— 图片是整个内联进请求的,
 *     历史一长请求体能翻几个数量级。
 *   - `wait`  在等待期间按 {@link LlmWaitHeartbeatMs} 周期发。它出现就证明
 *     worker 还活着、只是在等;它不出现就说明整个 isolate 卡住了。
 */
export interface LlmCallEvent {
  readonly event: "llm_call";
  readonly phase: "start" | "wait";
  readonly endpoint: string;
  readonly model: string;
  /**
   * 仅 start:请求体的字符数。
   *
   * 刻意不算字节:UTF-8 编码一遍要把整个请求体再复制一份,而这个体积正是
   * 它可能出问题的原因。图片以 base64 内联,是纯 ASCII,占了大头时两者一致。
   */
  readonly requestChars?: number;
  /** 仅 start。 */
  readonly messages?: number;
  /** 仅 start:内联进请求的图片数 —— 请求体膨胀几乎总是它带来的。 */
  readonly images?: number;
  /** 仅 start。 */
  readonly tools?: number;
  /** 仅 wait:已经等了多久。 */
  readonly elapsedMs?: number;
}

/** `llm_call` `phase:"wait"` 的间隔。够密看得出卡住,够疏不刷屏。 */
export const LlmWaitHeartbeatMs = 15_000;

export type ObservedEvent = HttpCallEvent | AgentRunEvent | AgentStepEvent | LlmCallEvent;

export type ObserveFn = (event: ObservedEvent) => void;

/**
 * 把异常折成 `{error, stack}`，与 httpCallFailure 同一套处理：展开 cause
 * （底层的 ECONNRESET 常被藏在 `TypeError: fetch failed` 里面），栈按
 * {@link ObservedStackCap} 截断。
 */
export function observedFailure(error: unknown): { error: string; stack?: string } {
  if (!(error instanceof Error)) return { error: String(error) };
  const cause = error.cause;
  const causeText = cause instanceof Error ? ` (cause: ${cause.name}: ${cause.message})` : "";
  const stack = [error.stack, cause instanceof Error ? cause.stack : undefined]
    .filter((v): v is string => typeof v === "string")
    .join("\ncaused by: ");
  return {
    error: `${error.name}: ${error.message}${causeText}`,
    ...(stack ? { stack: stack.length > ObservedStackCap ? stack.slice(0, ObservedStackCap) : stack } : {}),
  };
}

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
  /** 响应头到达的耗时;调用方分别计时的才传。 */
  readonly ttfbMs?: number;
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
  detail?: { responseBody?: string; truncated?: boolean; error?: string; stack?: string },
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
    ...(input.ttfbMs !== undefined ? { ttfbMs: input.ttfbMs } : {}),
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
    ...(detail?.stack !== undefined ? { stack: detail.stack } : {}),
  };
}

/**
 * 没拿到响应时的事件:status 记 0,带上异常与**完整栈**。
 *
 * 这一档是超时、连接被切、DNS 失败 —— 浏览器侧的 `Failed to fetch` 在服务端
 * 的样子。没有上游响应体可看,栈就是全部线索,所以这里不吝啬。`cause` 也一并
 * 展开:undici 把底层的 ECONNRESET / ETIMEDOUT 藏在 `TypeError: fetch failed`
 * 的 cause 里,只看外层那句话什么都看不出来。
 */
export function httpCallFailure(input: HttpCallInput, error: unknown): HttpCallEvent {
  return httpCallEvent(input, 0, observedFailure(error));
}
