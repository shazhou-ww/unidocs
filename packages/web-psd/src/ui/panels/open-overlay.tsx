import { useUiState, type OpenPhase } from "../store.js";

/**
 * 打开一个文件时盖住画布列的加载遮罩。
 *
 * 阶段制,不显示百分比:四段里「服务端解析」和「worker 解码」根本无从测量,
 * 凑出来的百分比只能靠估算填补,结果就是经典的「卡在 87%」。阶段名本身已经
 * 回答了「现在在干什么、还剩几步」。
 *
 * 只读 `store`,不 import `controller.js`——`tests/no-import-cycles.test.ts`
 * 盯着这件事,而画布列里已经有组件走 controller 了。
 */
const PHASES: { id: OpenPhase; step: string; running: string }[] = [
  { id: "upload", step: "上传", running: "正在上传…" },
  { id: "parse", step: "解析", running: "正在解析…" },
  { id: "load", step: "载入", running: "正在载入…" },
  { id: "render", step: "渲染", running: "正在渲染…" },
];

export function OpenOverlay() {
  const { opening } = useUiState();
  if (!opening) return null;
  const at = PHASES.findIndex((p) => p.id === opening.phase);
  return (
    // role="status" + aria-live:阶段推进对读屏用户也要能听见,而遮罩本身
    // 没有任何可聚焦的东西,不该抢焦点。
    <div className="open-overlay" role="status" aria-live="polite">
      <div className="open-card">
        <ol className="open-steps">
          {PHASES.map((p, i) => (
            <li key={p.id} data-state={i < at ? "done" : i === at ? "now" : "todo"}>
              <i />
              <span>{p.step}</span>
            </li>
          ))}
        </ol>
        <p className="open-file mono">{`${opening.name} · ${formatBytes(opening.bytes)}`}</p>
        <p className="open-phase">{PHASES[at].running}</p>
      </div>
    </div>
  );
}

/** 字节数按 B / KB / MB 显示。一位小数:42.1 MB 和 42 MB 在等一个大文件的时候
 *  是两种不同的信息量。 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
