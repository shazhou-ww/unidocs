/**
 * 右栏四种渲染的判定，对应 tenant-webui-v0.md §2.2 与 spec §4.2。
 *
 * 平台不做语义迁移，也不因为 current 前移就作废旧版本上的评论。第三、四种的常见成因
 * 不是用户自己改的，而是 Agent 处理别的一处评论时顺带改掉了这段内容。
 */
import type { PingRecord, PongRecord, VersionIdx } from "@unidocs/protocol-platform";
import { resolveMarkdownTextRange } from "@unidocs/tenant-portal-client";
import type { RoledMarker } from "../view/markers.js";

export type RightPaneKind = "pong-result" | "same-version" | "stale-present" | "stale-rewritten";

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
  if (!resolution.located) return { kind: "stale-rewritten", markers: [] };

  return {
    kind: "stale-present",
    markers: [{ threadId: "", pingIdx: ping.pingIdx, open: true, location: ping.location, role: "stale-ping" }],
  };
}
