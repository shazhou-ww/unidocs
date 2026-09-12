/**
 * 右栏四种渲染的判定，对应 tenant-webui-v0.md §2.2 与 spec §4.2。
 *
 * 平台不做语义迁移，也不因为 current 前移就作废旧版本上的评论。第三、四种的常见成因
 * 不是用户自己改的，而是 Agent 处理别的一处评论时顺带改掉了这段内容。
 */
import type { CommentRecord, ReplyRecord } from "@unidocs/protocol-tenant-portal";
import { resolveMarkdownTextRange, type VersionIdx } from "@unidocs/tenant-portal-client";
import type { RoledMarker } from "../view/markers.js";

export type RightPaneKind = "reply-result" | "same-version" | "stale-present" | "stale-rewritten" | "unsupported-location";

export interface RightPaneDecision {
  readonly kind: RightPaneKind;
  readonly markers: readonly RoledMarker[];
}

export function decideRightPane(input: {
  comment: CommentRecord;
  replies: readonly ReplyRecord[];
  currentVersionIdx: VersionIdx | null;
  currentContent: string;
}): RightPaneDecision {
  const { comment, replies, currentVersionIdx, currentContent } = input;

  const covering = replies.filter((reply) => reply.respondThroughCommentIdx >= comment.commentIdx);
  if (covering.length > 0) {
    const latest = covering[covering.length - 1];
    return {
      kind: "reply-result",
      // role 仍用 "pong-result"：它驱动的是 styles.css 里的 .marker-pong-result，
      // 是渲染层的既有命名，不随协议里 ping/pong → comment/reply 的改名而改——
      // 改了这里就要连带改 CSS，超出本轮协议对齐的范围。
      markers: latest.resultLocations.map((location) => ({
        threadId: "", commentIdx: comment.commentIdx, open: false, location, role: "pong-result" as const,
      })),
    };
  }

  if (comment.baseVersionIdx === currentVersionIdx) return { kind: "same-version", markers: [] };
  if (comment.location === null) return { kind: "same-version", markers: [] };

  const resolution = resolveMarkdownTextRange(comment.location, currentContent);
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
    markers: [{ threadId: "", commentIdx: comment.commentIdx, open: true, location: comment.location, role: "stale-ping" }],
  };
}
