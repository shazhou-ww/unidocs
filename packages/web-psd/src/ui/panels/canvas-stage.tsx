import { useEffect, useRef } from "react";
import { initController } from "../controller.js";

/**
 * The <canvas> is mounted by ref and then owned entirely by DocController /
 * Viewport / RenderClient — React never re-renders it. That is what keeps the
 * incremental tile compositor's performance intact across the redesign.
 */
export function CanvasStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (stageRef.current && viewRef.current) initController(viewRef.current, stageRef.current);
  }, []);

  return (
    <div className="stage" ref={stageRef}>
      <canvas className="view" ref={viewRef} aria-label="rendered preview" />
    </div>
  );
}
