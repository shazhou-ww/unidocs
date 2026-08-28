import { TopBar } from "./panels/top-bar.js";
import { CanvasStage } from "./panels/canvas-stage.js";

/**
 * Three-column shell. Column ORDER comes from styles.css (`order: 1|2|3`),
 * matching the redesign: Chat left (396px), canvas centre, layers/props right
 * (296px). Later tasks fill each column in; this file only owns the frame.
 */
export function App() {
  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <section className="col-chat">
          <div className="col-head"><strong>Chat</strong></div>
        </section>
        <section className="col-canvas">
          <CanvasStage />
        </section>
        <aside className="col-panel">
          <div className="col-head">
            <span>图层</span>
            <span>属性</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
