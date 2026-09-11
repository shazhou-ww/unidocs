import { useState } from "react";

export function Composer(props: {
  label: string;
  initialText?: string;
  onSend(text: string): void;
  onCancel(): void;
  onChange?(text: string): void;
}) {
  const [text, setText] = useState(props.initialText ?? "");

  return (
    <div className="composer">
      <textarea
        aria-label={props.label}
        value={text}
        autoFocus
        onChange={(event) => { setText(event.target.value); props.onChange?.(event.target.value); }}
      />
      <div className="composer-actions">
        <button type="button" onClick={() => props.onSend(text)} disabled={text.trim() === ""}>发送</button>
        <button type="button" onClick={props.onCancel}>取消</button>
      </div>
    </div>
  );
}
