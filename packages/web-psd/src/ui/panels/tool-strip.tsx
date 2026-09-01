import { setState, useUiState, type ToolId } from "../store.js";

const TOOLS: { id: ToolId; label: string }[] = [
  { id: "move", label: "移动" },
  { id: "marquee", label: "框选" },
  { id: "eyedrop", label: "取色" },
];

export function ToolStrip() {
  const s = useUiState();
  return (
    // `inert` 不挂在这里——挂在父级 `context-bar.tsx` 的根元素上。这里只是
    // 那条 bar 的一部分,单独锁住这一段挡不住通过 Tab 到达 bar 自己那几个
    // 按钮(裁到选区等)的键盘用户;一个决定只该有一个主体。`.is-locked`
    // 仍留在这里,纯视觉,和拦截职责无关。
    <div className={`tools${s.opening ? " is-locked" : ""}`}>
      {TOOLS.map((t) => (
        <button key={t.id} type="button" data-on={s.tool === t.id || undefined}
                onClick={() => setState({ tool: t.id })}>{t.label}</button>
      ))}
    </div>
  );
}
