/**
 * 右栏四种渲染的判定，对应 tenant-webui-v0.md §2.2 与 spec §4.2。
 *
 * 平台不做语义迁移，也不因为 current 前移就作废旧版本上的评论。第三、四种的常见成因
 * 不是用户自己改的，而是 Agent 处理别的一处评论时顺带改掉了这段内容。
 */
import type { PingRecord, PongRecord, VersionIdx } from "@unidocs/protocol-platform";
import { resolveMarkdownTextRange } from "@unidocs/tenant-portal-client";
import type { RoledMarker } from "../view/markers.js";

export type RightPaneKind = "pong-result" | "same-version" | "stale-present" | "stale-rewritten" | "unsupported-location";

export interface RightPaneDecision {
  readonly kind: RightPaneKind;
  readonly markers: readonly RoledMarker[];
}

export function decideRightPane(input: {
  ping: PingRecord;
  pongs: readonly PongRecord[];
  currentVersionIdx: VersionIdx | null;
  currentContent: string;
}): RightPaneDecision {
  const { ping, pongs, currentVersionIdx, currentContent } = input;

  const covering = pongs.filter((pong) => pong.respondThroughPingIdx >= ping.pingIdx);
  if (covering.length > 0) {
    const latest = covering[covering.length - 1];
    return {
      kind: "pong-result",
      markers: latest.resultLocations.map((location) => ({
        threadId: "", pingIdx: ping.pingIdx, open: false, location, role: "pong-result" as const,
      })),
    };
  }

  if (ping.baseVersionIdx === currentVersionIdx) return { kind: "same-version", markers: [] };
  if (ping.location === null) return { kind: "same-version", markers: [] };

  const resolution = resolveMarkdownTextRange(ping.location, currentContent);
  if (!resolution.located) {
    // spec §4.2：第三、四种的区分本该由 View 回答（ViewFocusLocationResponse 的
    // { located, reason }），这里直接调 resolveMarkdownTextRange 是本轮对 spec 的
    // 偏离（记在 spec §11）。但即使这样猜，也不能把「这个 host 看不懂的位置类型」
    // 误判成「内容已经不在了」——resolveMarkdownTextRange 对非 Markdown 文本区间
    // 位置同样返回 unsupported_type，那是「host 判断不了」，不是「确实不在了」。
    // 前者必须诚实地说不知道，绝不能顺着 stale-rewritten 分支说出一句错误的断言。
    if (resolution.reason === "unsupported_type") return { kind: "unsupported-location", markers: [] };
    return { kind: "stale-rewritten", markers: [] };
  }

  return {
    kind: "stale-present",
    markers: [{ threadId: "", pingIdx: ping.pingIdx, open: true, location: ping.location, role: "stale-ping" }],
  };
}
