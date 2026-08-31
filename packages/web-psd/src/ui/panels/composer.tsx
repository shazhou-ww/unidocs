import { useState } from "react";
import { selectedLayers, useUiState } from "../store.js";
import type { AgentTarget } from "../api.js";
import type { Region } from "../region.js";

export function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string, target: AgentTarget | null) => void }) {
  const s = useUiState();
  const [text, setText] = useState("");
  // The region the user took OFF the composer, held by identity rather than
  // by a boolean: every drag produces a fresh Region object, so a new
  // selection re-attaches on its own and the dismissal only ever applies to
  // the one region it was aimed at.
  const [dropped, setDropped] = useState<Region | null>(null);

  const attached = s.region && s.region !== dropped ? s.region : null;
  const target: AgentTarget | null = attached
    ? { bounds: attached.bounds, layerNames: selectedLayers(s).map((l) => l.name) }
    : null;

  const submit = (): void => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    onSend(t, target);
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
          {/* The region rides along on EVERY turn (spec §4.3): drop it after
              the first and "a bit more to the left" three turns later has
              nothing to refer to. That makes it state leaving the browser
              silently, so it is shown, and it comes off in one click. */}
          {attached ? (
            <button
              type="button"
              className="chip chip-on"
              aria-label="不附带选区"
              title="点击后本次不再附带选区"
              onClick={() => setDropped(attached)}
            >
              {`已附带选区 ${attached.bounds[3] - attached.bounds[1]} × ${attached.bounds[2] - attached.bounds[0]}`}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>发送</button>
        </div>
      </div>
    </div>
  );
}
