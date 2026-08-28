import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatPanel } from "../src/ui/panels/chat-panel.js";
import { setState, getState } from "../src/ui/store.js";

const runAgent = vi.fn(async () => "角标已移到右下");
const resetAgent = vi.fn(async () => {});
const fetchHistory = vi.fn(async () => [
  { version: 12, timestamp: "t", description: "op#12", operations: [{ kind: "transform" }] },
]);
const reconcile = vi.fn(async () => { setState({ version: 12 }); });

vi.mock("../src/ui/api.js", () => ({
  runAgent: (...a: unknown[]) => runAgent(...(a as [])),
  resetAgent: (...a: unknown[]) => resetAgent(...(a as [])),
  fetchHistory: (...a: unknown[]) => fetchHistory(...(a as [])),
  rollback: vi.fn(),
}));
vi.mock("../src/ui/controller.js", () => ({ getController: () => ({ reconcile }) }));

beforeEach(() => {
  runAgent.mockClear(); resetAgent.mockClear(); fetchHistory.mockClear(); reconcile.mockClear();
  setState({ docId: "abc", version: 11, sessionBaseVersion: 11, chat: [], chatBusy: false,
             history: [], historyOpen: false, selection: [], doc: null });
});

describe("ChatPanel", () => {
  it("sends an instruction, reconciles, then shows the reply", async () => {
    render(<ChatPanel />);
    fireEvent.change(screen.getByPlaceholderText(/说明要改什么/), { target: { value: "把角标挪到右下" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(screen.getByText("角标已移到右下")).toBeInTheDocument());
    expect(runAgent).toHaveBeenCalledWith("abc", "把角标挪到右下");
    expect(reconcile).toHaveBeenCalled();
    expect(fetchHistory).toHaveBeenCalledWith("abc");
    const reply = getState().chat.at(-1)!;
    expect(reply.fromVersion).toBe(11);
    expect(reply.toVersion).toBe(12);
  });

  it("surfaces an agent failure as an error message", async () => {
    runAgent.mockRejectedValueOnce(new Error("llm unavailable"));
    render(<ChatPanel />);
    fireEvent.change(screen.getByPlaceholderText(/说明要改什么/), { target: { value: "x" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(screen.getByText("llm unavailable")).toBeInTheDocument());
    expect(getState().chatBusy).toBe(false);
  });

  it("clears the transcript and the server session on 新会话", async () => {
    setState({ chat: [{ role: "user", text: "hi" }] });
    render(<ChatPanel />);
    fireEvent.click(screen.getByText("新会话"));
    await waitFor(() => expect(getState().chat).toEqual([]));
    expect(resetAgent).toHaveBeenCalledWith("abc");
  });

  it("opens the history drawer from the ops counter", async () => {
    setState({ history: [{ version: 12, timestamp: "t", description: "op#12", operations: [] }] });
    render(<ChatPanel />);
    fireEvent.click(screen.getByText(/1 ops · 本次会话/));
    await waitFor(() => expect(getState().historyOpen).toBe(true));
    expect(fetchHistory).toHaveBeenCalled();
  });
});
