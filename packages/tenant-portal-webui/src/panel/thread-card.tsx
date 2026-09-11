import type { PingRecord, PongRecord, VersionIdx } from "@unidocs/protocol-platform";
import type { ThreadState } from "../model/thread-state.js";

export function PingCard(props: {
  ping: PingRecord;
  currentVersionIdx: VersionIdx | null;
  selected?: boolean;
  onSelect?(): void;
}) {
  const behind = props.currentVersionIdx === null ? 0 : props.currentVersionIdx - props.ping.baseVersionIdx;

  return (
    <li className={`ping-card${props.selected === true ? " selected" : ""}`}>
      <button type="button" onClick={props.onSelect}>
        <p>{props.ping.content.text}</p>
        <footer>
          <span className="version-badge">v{props.ping.baseVersionIdx}</span>
          {behind > 0 && <span className="behind">基于 v{props.ping.baseVersionIdx} · 已过 {behind} 版</span>}
        </footer>
      </button>
    </li>
  );
}

export function PongCard(props: { pong: PongRecord }) {
  const plain = props.pong.resultLocations.length === 0;

  return (
    <li className={`pong-card ${plain ? "pong-plain" : "pong-versioned"}`}>
      <p>{props.pong.content.text}</p>
      <footer>{plain ? "Agent 已回复，未改动内容" : "Agent 已处理并提交了新版本"}</footer>
    </li>
  );
}

export function ThreadCard(props: {
  threadId: string;
  pings: readonly PingRecord[];
  pongs: readonly PongRecord[];
  state: ThreadState;
  currentVersionIdx: VersionIdx | null;
  selected: boolean;
  selectedPingIdx?: number;
  onSelect(): void;
  onSelectPing?(pingIdx: number): void;
}) {
  const first = props.pings[0];

  return (
    <article className={`thread-card${props.selected ? " selected" : ""}`}>
      <button type="button" onClick={props.onSelect}>
        <span className={props.state.open ? "status-open" : "status-answered"}>
          {props.state.open ? "待回复" : "已回复"}
        </span>
        {/* 展开后详情已经在下面的 PingCard 里逐条给出，摘要行不再重复，
            顺带避免摘要文字与展开后某条评论文字相同时，可访问名撞车。 */}
        {!props.selected && <span className="thread-excerpt">{first?.content.text}</span>}
      </button>

      {props.selected && (
        <ul className="thread-messages">
          {props.pings.map((ping) => (
            <PingCard
              key={ping.pingIdx}
              ping={ping}
              currentVersionIdx={props.currentVersionIdx}
              selected={props.selectedPingIdx === ping.pingIdx}
              onSelect={() => props.onSelectPing?.(ping.pingIdx)}
            />
          ))}
          {props.pongs.map((pong) => <PongCard key={pong.pongIdx} pong={pong} />)}
        </ul>
      )}
    </article>
  );
}
