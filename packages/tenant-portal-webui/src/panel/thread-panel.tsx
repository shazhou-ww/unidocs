import { useState } from "react";
import type { VersionIdx } from "@unidocs/protocol-platform";
import type { SummarizedThread } from "../model/discussion-summary.js";
import { ThreadCard } from "./thread-card.js";

export type ThreadFilter = "all" | "open" | "answered";

const FILTERS: readonly { value: ThreadFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "open", label: "待回复" },
  { value: "answered", label: "已回复" },
];

export function ThreadPanel(props: {
  threads: readonly SummarizedThread[];
  currentVersionIdx: VersionIdx | null;
  selectedThreadId?: string;
  selectedPingIdx?: number;
  onSelect(threadId: string): void;
  onSelectPing?(pingIdx: number): void;
}) {
  const [filter, setFilter] = useState<ThreadFilter>("all");

  const visible = props.threads.filter(({ state }) =>
    filter === "all" || (filter === "open" ? state.open : !state.open));

  return (
    <aside className="thread-panel" role="complementary" aria-label="讨论">
      <nav className="thread-filter">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </nav>

      {visible.length === 0 && <p className="muted">暂无讨论。在正文里选中一段内容即可添加评论。</p>}

      {visible.map(({ detail, state }) => (
        <ThreadCard
          key={detail.threadId}
          threadId={detail.threadId}
          pings={detail.pings}
          pongs={detail.pongs}
          state={state}
          currentVersionIdx={props.currentVersionIdx}
          selected={props.selectedThreadId === detail.threadId}
          selectedPingIdx={props.selectedPingIdx}
          onSelect={() => props.onSelect(detail.threadId)}
          onSelectPing={props.onSelectPing}
        />
      ))}
    </aside>
  );
}
