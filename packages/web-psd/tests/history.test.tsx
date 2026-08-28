import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OpsList } from "../src/ui/panels/ops-list.js";
import { HistoryDrawer } from "../src/ui/panels/history-drawer.js";
import { setState, getState } from "../src/ui/store.js";

const rollback = vi.fn(async () => 14);
const reconcile = vi.fn(async () => {});
vi.mock("../src/ui/api.js", () => ({ rollback: (...a: unknown[]) => rollback(...(a as [])), fetchHistory: vi.fn() }));
vi.mock("../src/ui/controller.js", () => ({ getController: () => ({ reconcile }) }));

const entry = (version: number, ops: unknown[] = [{ kind: "transform" }]) =>
  ({ version, timestamp: "2026-08-28T00:00:00Z", description: `op#${version}`, operations: ops });

beforeEach(() => {
  rollback.mockClear(); reconcile.mockClear();
  setState({ docId: "abc", version: 14, sessionBaseVersion: 11, historyOpen: true,
             history: [entry(10), entry(12), entry(13), entry(14)] });
});

describe("OpsList", () => {
  it("summarises the operation count and expands to show the op JSON", () => {
    render(<OpsList entries={[entry(12), entry(13)]} />);
    expect(screen.getByText("2 operations")).toBeInTheDocument();
    expect(screen.queryByText(/"kind": "transform"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("查看 diff"));
    expect(screen.getAllByText(/"kind": "transform"/).length).toBe(2);
  });

  it("rolls back to the version BEFORE the first listed entry", async () => {
    render(<OpsList entries={[entry(12), entry(13)]} />);
    fireEvent.click(screen.getByText("回退这 2 步"));
    expect(rollback).toHaveBeenCalledWith("abc", 11);
  });
});

describe("HistoryDrawer", () => {
  it("lists only this session's ops and labels the current head", () => {
    render(<HistoryDrawer />);
    expect(screen.getByText("op#12")).toBeInTheDocument();
    expect(screen.getByText("op#14")).toBeInTheDocument();
    expect(screen.queryByText("op#10")).not.toBeInTheDocument();
    expect(screen.getByLabelText("当前版本")).toHaveTextContent("op#14");
  });

  it("closes on the close button", () => {
    render(<HistoryDrawer />);
    fireEvent.click(screen.getByLabelText("关闭历史"));
    expect(getState().historyOpen).toBe(false);
  });
});
