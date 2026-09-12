/**
 * 临时定义，等协议补齐后整文件删除。
 *
 * ViewSetMarkersRequest.markers 目前是 { threadId, commentIdx, open, location }，区分不了
 * 「这是评论」「这是回复的结果」「这是已过时的评论」。spec §4.2 的右栏四种渲染需要
 * 这个区分。缺口记在 docs/design/platform-v0/tenant/TODO.md，等协议设计定稿后，把
 * role 加进协议 marker 并删掉本文件。
 */
import type { ViewSetMarkersRequest } from "@unidocs/protocol-platform";

export type ProtocolMarker = ViewSetMarkersRequest["markers"][number];

export type MarkerRole = "ping" | "pong-result" | "stale-ping";

export interface RoledMarker extends ProtocolMarker {
  readonly role: MarkerRole;
}

export function toProtocolMarkers(markers: readonly RoledMarker[]): readonly ProtocolMarker[] {
  return markers.map(({ role, ...marker }) => marker);
}
