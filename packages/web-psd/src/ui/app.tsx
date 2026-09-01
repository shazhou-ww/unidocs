import { useEffect } from "react";
import { TopBar } from "./panels/top-bar.js";
import { CanvasStage } from "./panels/canvas-stage.js";
import { ContextBar } from "./panels/context-bar.js";
import { SidePanel } from "./panels/side-panel.js";
import { ChatPanel } from "./panels/chat-panel.js";
import { OpenOverlay } from "./panels/open-overlay.js";
import { zoomActual, zoomFit, zoomStep } from "./zoom-controller.js";
import { setRegion, setSelection } from "./store.js";

/**
 * Three-column shell. Column ORDER comes from styles.css (`order: 1|2|3`),
 * matching the redesign: Chat left (396px), canvas centre, layers/props right
 * (296px).
 */
export function App() {
  useZoomShortcuts();
  useSelectionShortcuts();
  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <ChatPanel />
        <section className="col-canvas">
          <CanvasStage />
          <ContextBar />
          <OpenOverlay />
        </section>
        <SidePanel />
      </div>
    </div>
  );
}

/**
 * ⌘/Ctrl + 0 fits, + 1 goes to 100%, + =/- step the ladder — the bindings
 * every image editor shares.
 *
 * Ignored while the user is typing (the chat composer is a textarea in this
 * same shell), because ⌘0 in a text field is not a zoom request. Bound on
 * `window` rather than a focusable element so the shortcuts work without
 * having to click the canvas first.
 */
function useZoomShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.metaKey && !e.ctrlKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      switch (e.key) {
        case "0": e.preventDefault(); zoomFit(); break;
        case "1": e.preventDefault(); zoomActual(); break;
        // "=" is the unshifted "+" on most layouts; accept both so the
        // shortcut works whether or not shift is held.
        case "=": case "+": e.preventDefault(); zoomStep(1); break;
        case "-": e.preventDefault(); zoomStep(-1); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * Escape clears BOTH axes at once — the one gesture that does, because it is
 * the "never mind" key and leaving half a target behind is exactly what it is
 * for. Everything else leaves the other axis alone (spec §3.3).
 *
 * Bound on `window`, and ignored while typing: Escape in the chat composer is
 * not a request to drop the selection.
 */
function useSelectionShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      setSelection([]);
      setRegion(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
