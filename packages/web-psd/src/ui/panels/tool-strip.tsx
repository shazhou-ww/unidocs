import { setState, useUiState, type ToolId } from "../store.js";

const TOOLS: { id: ToolId; label: string }[] = [
  { id: "move", label: "移动" },
  { id: "marquee", label: "框选" },
  { id: "eyedrop", label: "取色" },
];

export function ToolStrip() {
  const s = useUiState();
  return (
    <div className="tools">
      {TOOLS.map((t) => (
        <button key={t.id} type="button" data-on={s.tool === t.id || undefined}
                onClick={() => setState({ tool: t.id })}>{t.label}</button>
      ))}
    </div>
  );
}
