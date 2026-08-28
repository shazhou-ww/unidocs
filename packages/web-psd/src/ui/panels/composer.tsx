import { useState } from "react";
import { selectedLayers, useUiState } from "../store.js";

export function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const s = useUiState();
  const [text, setText] = useState("");

  const submit = (): void => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t);
  };

  // Phase 1: "@layer" only injects TEXT into the instruction. Real structured
  // context (the selected IR subtree travelling with the request) needs the
  // /run contract widened — that is phase 2, foundation 6.
  const mention = (): void => {
    const names = selectedLayers(s).map((l) => `@${l.name}`).join(" ");
    if (names) setText((t) => (t ? `${t} ${names} ` : `${names} `));
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          value={text}
          placeholder="说明要改什么，或先在画布上框出问题区域…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <div className="composer-actions">
          <button type="button" className="chip" onClick={mention}>@ 图层</button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>发送</button>
        </div>
      </div>
    </div>
  );
}
