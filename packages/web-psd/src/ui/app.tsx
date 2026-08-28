import { TopBar } from "./panels/top-bar.js";
import { CanvasStage } from "./panels/canvas-stage.js";
import { ContextBar } from "./panels/context-bar.js";
import { SidePanel } from "./panels/side-panel.js";
import { ChatPanel } from "./panels/chat-panel.js";

/**
 * Three-column shell. Column ORDER comes from styles.css (`order: 1|2|3`),
 * matching the redesign: Chat left (396px), canvas centre, layers/props right
 * (296px).
 */
export function App() {
  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <ChatPanel />
        <section className="col-canvas">
          <CanvasStage />
          <ContextBar />
        </section>
        <SidePanel />
      </div>
    </div>
  );
}
