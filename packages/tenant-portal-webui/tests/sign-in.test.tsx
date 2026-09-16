import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/shell/app-shell.js";
import { loginHref, readLoginOutcome, withoutLoginOutcome } from "../src/session/sign-in.js";
import { SignedOutNotice } from "../src/session/signed-out-notice.js";

describe("loginHref", () => {
  it("keeps the hash route so a deep link survives the round trip", () => {
    expect(loginHref({ pathname: "/portal/", hash: "#/d/doc%201/th-1/0" }))
      .toBe(`/portal/auth/login?returnTo=${encodeURIComponent("/portal/#/d/doc%201/th-1/0")}`);
  });

  it.each(["/portal", "/portal/index.html", "/portal/foo", "/elsewhere", ""])("normalizes the shell path %j to /portal/", pathname => {
    expect(loginHref({ pathname, hash: "" })).toBe(`/portal/auth/login?returnTo=${encodeURIComponent("/portal/")}`);
  });
});

describe("readLoginOutcome", () => {
  it.each(["denied", "failed", "unavailable"] as const)("reads login=%s with its request id", kind => {
    expect(readLoginOutcome(`?login=${kind}&requestId=req-1`)).toEqual({ kind, requestId: "req-1" });
  });

  it("ignores anything else", () => {
    expect(readLoginOutcome("")).toBeNull();
    expect(readLoginOutcome("?login=granted")).toBeNull();
  });

  it("strips only the login parameters and keeps the hash", () => {
    expect(withoutLoginOutcome({ pathname: "/portal/", search: "?login=denied&requestId=r&tab=1", hash: "#/d/doc-1" })).toBe("/portal/?tab=1#/d/doc-1");
    expect(withoutLoginOutcome({ pathname: "/portal/", search: "?login=failed&requestId=r", hash: "" })).toBe("/portal/");
  });
});

describe("SignedOutNotice", () => {
  const location = { pathname: "/portal/", hash: "#/d/doc-1" };

  it("offers Google sign-in back to the current location", () => {
    render(<SignedOutNotice outcome={null} location={location} />);
    expect(screen.getByRole("heading", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByText("首次登录会自动创建你的工作空间。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "使用 Google 账号继续" })).toHaveAttribute("href", loginHref(location));
  });

  it("does not offer a Microsoft sign-in option", () => {
    render(<SignedOutNotice outcome={null} location={location} />);
    expect(screen.queryByRole("link", { name: /Microsoft/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Microsoft/i })).toBeNull();
  });

  it.each([
    ["denied", "这个邮箱已经绑定了另一个 Google 账号"],
    ["failed", "登录没有完成，请重试"],
    ["unavailable", "登录暂时不可用，请稍后再试"],
  ] as const)("explains login=%s with role=status and shows the request id", (kind, message) => {
    render(<SignedOutNotice outcome={{ kind, requestId: "req-42" }} location={location} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(message);
    expect(status).toHaveTextContent("req-42");
  });

  it.each([
    ["denied", "这个邮箱已经绑定了另一个 Google 账号"],
    ["failed", "登录没有完成，请重试"],
    ["unavailable", "登录暂时不可用，请稍后再试"],
  ] as const)("explains login=%s with role=status when there is no request id", (kind, message) => {
    render(<SignedOutNotice outcome={{ kind, requestId: null }} location={location} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(message);
  });

  it("renders no outcome line when there is none", () => {
    render(<SignedOutNotice outcome={null} location={location} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Sidebar sign-out", () => {
  it("renders a sign-out button only when it can sign out", () => {
    const onSignOut = vi.fn();
    const { rerender } = render(<Sidebar documentCount={null} />);
    expect(screen.queryByRole("button", { name: "退出" })).toBeNull();
    rerender(<Sidebar documentCount={null} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
