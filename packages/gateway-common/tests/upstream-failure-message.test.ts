/**
 * 网关转发失败时合成给调用方的那句话。
 *
 * 由来:一次 237 MiB 的 PSD create 在线上超时,浏览器收到的是
 * `Document worker unreachable: TimeoutError: ...`。而日志显示 doc service
 * 一直好好的 —— 它在那 90 秒里收字节,超时之后还继续把 CAS root-refs 提交完
 * (200)才停。"unreachable" 这个词把排查引向了网络连通性,而真正的原因是
 * 我们自己设的 deadline 到点了,上游根本没出问题。
 *
 * 两种失败必须说成两件事:连不上(上游真的没接住)和超时(我们不等了,上游
 * 大概率还在跑)。状态码仍是 502 —— 改成 504 更准确,但那是另一件事,
 * observe.test.ts 里有测试把合成失败钉在 502 上。
 */
import { describe, expect, it } from "vitest";
import { upstreamFailureMessage } from "../src/gateway-handler.js";

describe("upstreamFailureMessage", () => {
  it("超时说成超时,并带上 deadline —— 读的人要知道是谁在计时", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");

    const message = upstreamFailureMessage(err, 240);

    expect(message).toContain("240");
    expect(message.toLowerCase()).toContain("timed out");
    // 关键的一句:上游没坏,别往连通性上查。
    expect(message).not.toContain("unreachable");
  });

  it("超时的说法要点明上游可能还在跑 —— 线上确实如此,会留下半截状态", () => {
    const err = new DOMException("aborted", "TimeoutError");

    expect(upstreamFailureMessage(err, 240)).toMatch(/still be running|仍/i);
  });

  it("真连不上仍然说 unreachable —— 这条没变,它本来就是对的", () => {
    const err = new TypeError("fetch failed");

    const message = upstreamFailureMessage(err, 240);

    expect(message).toContain("unreachable");
    expect(message).toContain("fetch failed");
  });

  it("调用方主动断开(AbortError)不算超时 —— 计时的不是我们", () => {
    const err = new DOMException("The operation was aborted", "AbortError");

    expect(upstreamFailureMessage(err, 240).toLowerCase()).not.toContain("timed out");
  });
});
