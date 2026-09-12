import type { Draft } from "../drafts/draft-store.js";

export function DraftBlock(props: {
  draft: Draft;
  failure: string | null;
  onRetry(): void;
  onDiscard(): void;
}) {
  return (
    <div className="draft-block" role="note" aria-label="未发送的评论">
      {props.draft.editedFromCommentIdx !== null && (
        <p className="draft-origin">改自评论 {props.draft.editedFromCommentIdx + 1}</p>
      )}
      <p className="draft-text">{props.draft.text}</p>
      {props.failure !== null && <p role="alert">{props.failure}</p>}
      <div className="draft-actions">
        <button type="button" onClick={props.onRetry}>{props.failure === null ? "发送" : "重试"}</button>
        <button type="button" onClick={props.onDiscard}>丢弃</button>
      </div>
    </div>
  );
}
