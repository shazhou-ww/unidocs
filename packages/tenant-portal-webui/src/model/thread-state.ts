/**
 * thread 的 open 状态是水位关系的结果，不是标志位——所以界面上没有解决/重新打开按钮。
 * 对应 tenant-webui-v0.md §2.1：open := latestPingSequence > acknowledgedPingSequence
 */
import type { PongRecord, ThreadDetail } from "@unidocs/protocol-platform";

export interface ThreadState {
  readonly open: boolean;
  readonly latestPingIdx: number;
  readonly acknowledgedPingIdx: number;
  readonly latestPong: PongRecord | null;
  /** 纯 pong：只回复、没产生新版本。界面上用中性色，不显示版本号。 */
  readonly latestPongIsPlain: boolean;
}

export function deriveThreadState(detail: ThreadDetail): ThreadState {
  const acknowledgedPingIdx = detail.pongs.reduce((max, pong) => Math.max(max, pong.respondThroughPingIdx), -1);
  const latestPingIdx = detail.pings.reduce((max, ping) => Math.max(max, ping.pingIdx), -1);
  const latestPong = detail.pongs.length === 0 ? null : detail.pongs[detail.pongs.length - 1];

  return {
    open: latestPingIdx > acknowledgedPingIdx,
    latestPingIdx,
    acknowledgedPingIdx,
    latestPong,
    latestPongIsPlain: latestPong !== null && latestPong.resultLocations.length === 0,
  };
}
