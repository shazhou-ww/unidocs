import { useState } from "react";
import { selectedLayers, useUiState, type UiState } from "../store.js";
import { findLayer, layersIntersecting } from "../hit-test.js";
import type { AgentTarget } from "../api.js";
import type { Region } from "../region.js";

/**
 * The layer list that travels with a region.
 *
 * Spec §4.3's fourth field is「与区域相交的图层清单」— who is on top of this
 * area — not "who is selected". The two coincide whenever layers ARE selected,
 * which is why sending the selection looked right; but the flagship case is a
 * region with nothing selected ("regenerate the part I boxed in"), and that
 * sent bounds and no layer list at all. Spec §3.2 defines exactly that
 * combination as "all the layers in this region", so deriving the names from
 * the region makes the message match the model the rest of the UI already
 * uses (the context bar's 选中区域内的图层 button reads the same function).
 *
 * NAMES only, never ids — see `AgentTarget`.
 */
function targetLayers(s: UiState, region: Region): { id: string; name: string }[] {
  // Always the layers the region overlaps — spec §4.3 asks for 「与区域相交的
  // 图层清单」, i.e. 「who is on top of this area」. Reading the SELECTED
  // layers instead would now be dead code as well as wrong: a region and a
  // layer selection cannot both be set (spec §3.3), so whenever there is a
  // region to attach, the selection is empty by construction.
  const layers = s.doc?.layers ?? [];
  return layersIntersecting(layers, region.bounds)
    .map((id) => { const l = findLayer(layers, id); return l ? { id: l.id, name: l.name } : null; })
    .filter((l): l is { id: string; name: string } => !!l);
}

export function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string, target: AgentTarget | null) => void }) {
  const s = useUiState();
  const [text, setText] = useState("");
  // The region the user took OFF the composer, held by identity rather than
  // by a boolean: every drag produces a fresh Region object, so a new
  // selection re-attaches on its own and the dismissal only ever applies to
  // the one region it was aimed at.
  const [dropped, setDropped] = useState<Region | null>(null);

  const attached = s.region && s.region !== dropped ? s.region : null;
  // 图层选择也要随指令走。以前只有拖出来的**选区**才附带 target，在图层面板
  // 里选中一层则什么都不附 —— 于是用户打"选中的图层中，网址改成 X"，agent
  // 收到的是一句指着它根本看不见的东西的话，只能靠 getLayers/getPreview 一层
  // 层猜。实测这样烧满 25 轮、182 秒，几乎不调图像模型。
  //
  // 选区与图层选择互斥（spec §3.3），所以这是干净的二选一，不会两个都有。
  const picked = selectedLayers(s);
  const target: AgentTarget | null = attached
    ? { bounds: attached.bounds, layers: targetLayers(s, attached) }
    : picked.length > 0
      ? { layers: picked.map((l) => ({ id: l.id, name: l.name })) }
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
