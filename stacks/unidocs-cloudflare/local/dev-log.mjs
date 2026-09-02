/**
 * 本地 dev 运行时的日志落盘。
 *
 * 存在的理由:`pnpm dev` 的所有输出——包括 `http_call` 结构化事件
 * (见 docs/observability.md)——原先只进终端,agent 要查一次日志得让人先
 * 手动 tee 一份。这里把同样的内容再写一份到文件,终端输出**一个字节不变**。
 *
 * 格式是 JSONL,一行一条记录,不是终端那份的原样拷贝:
 *
 *   {"t":"2026-09-02T10:03:11.482Z","src":"worker","level":"log",
 *    "event":"http_call","target":"cas","op":"lease","durationMs":13004}
 *   {"t":"...","src":"miniflare","msg":"[mf:inf] GET /tenants/u1/... 200 OK"}
 *
 * 这么选是因为读日志的是 agent 而不是人:`http_call` 那种本身就是 JSON 的行
 * 直接摊平进信封,`jq 'select(.event=="http_call")'` 一条就能筛,不用先按
 * 前缀切一刀;而多行的异常栈被 JSON 字符串转义成一行,行与记录始终一一对应,
 * grep 不会把一条栈切成几十条互不相干的"日志"。
 *
 * 本模块只依赖 node 内置模块——纯函数部分(`devLogRecord` / `devLogLine`)
 * 因此可以脱离 Miniflare 单测,和 doc-types.mjs 同一个约定。
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** 信封自己占用的键。载荷撞上其中任何一个就不摊平——见 `devLogRecord`。 */
const EnvelopeKeys = ["t", "src", "level", "msg", "json"];

/**
 * 把一行日志文本解析成 JSON 对象;不是一个**对象**字面量就返回 null。
 *
 * 卡得很紧(必须 `{` 开头 `}` 结尾)是故意的:宁可把一条本可摊平的行降级成
 * `msg` 字符串,也不要把一行普通文本里碰巧出现的花括号当成结构化载荷。
 */
function parseJsonObject(text) {
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * 组装一条记录。
 *
 * `src` 分两种:`"worker"` 是 workerd 转出来的、Worker 自己 `console.*` 打的
 * (`http_call` / `doc_authentication` 这些都在这里);`"miniflare"` 是
 * Miniflare 运行时自己那几行(`[mf:inf] …` 请求行、启动就绪、内部告警)。
 *
 * ANSI 一律剥掉:Miniflare 给自己的行上了色,而带转义序列的字段会让下游
 * 的等值匹配莫名其妙地不命中。
 */
export function devLogRecord({ src, level, message, timestamp = Date.now() }) {
  const envelope = {
    t: new Date(timestamp).toISOString(),
    src,
    ...(level === undefined ? {} : { level }),
  };
  const text = stripVTControlCharacters(String(message)).trim();
  const payload = parseJsonObject(text);
  if (payload === null) return { ...envelope, msg: text };
  // 载荷自带信封键时嵌套而不是摊平:摊平会让载荷的 `t` 顶掉我们的时间戳,
  // 那是**丢数据**,而嵌套只是多一层 `.json`。
  if (EnvelopeKeys.some((key) => key in payload)) return { ...envelope, json: payload };
  return { ...envelope, ...payload };
}

/** 一条记录 + 换行。JSONL 的一行。 */
export function devLogLine(input) {
  return `${JSON.stringify(devLogRecord(input))}\n`;
}

/**
 * 打开日志文件,返回一个 sink。每次 `pnpm dev` 都从头写(`"w"`),所以文件
 * 里永远只有**本次**这一趟的日志——agent 不必先分辨哪些行是上一次跑剩下的。
 *
 * 写用同步的 `writeSync` 而非 `createWriteStream`:dev 日志量很小,而流的
 * 缓冲会让"跑着的时候另开一个终端 grep"看到的内容落后好几秒,SIGKILL 时
 * 更是直接丢掉尾巴。同步写把这两个问题一起消掉。
 */
export function openDevLog(path) {
  mkdirSync(dirname(path), { recursive: true });
  let fd = openSync(path, "w");
  const disable = (reason) => {
    const open = fd;
    fd = null;
    try {
      closeSync(open);
    } catch {
      // 已经关不掉了就算了——这里正在处理的就是落盘出问题的路径。
    }
    // 刻意用 process.stderr 而不是 console.error:这个 sink 挂在日志管线上,
    // 走 console 有可能再绕回这里来,一次失败变成无限递归。
    process.stderr.write(`dev log sink disabled (${path}): ${reason}\n`);
  };
  return {
    path,
    /** 落盘失败绝不能把 dev 跑挂:关掉 sink,报一次,终端输出照旧。 */
    write(input) {
      if (fd === null) return;
      try {
        writeSync(fd, devLogLine(input));
      } catch (err) {
        disable(err instanceof Error ? err.message : String(err));
      }
    },
    close() {
      if (fd === null) return;
      const open = fd;
      fd = null;
      closeSync(open);
    },
  };
}
