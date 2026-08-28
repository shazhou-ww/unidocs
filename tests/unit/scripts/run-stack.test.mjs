import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_STACK,
  listStacks,
  resolveInvocation,
  resolveStackEntry,
  STACK_ACTION_ENTRIES,
} from "../../../scripts/run-stack.mjs";

const STACKS = ["unicas", "unidocs-azure", "unidocs-cloudflare"];

describe("stack command routing", () => {
  it("maps actions to fixed paths below the selected stack", () => {
    expect(STACK_ACTION_ENTRIES).toEqual({
      dev: ["local", "dev.mjs"],
      deploy: ["deploy", "deploy.mjs"],
      smoke: ["deploy", "smoke.mjs"],
    });
    expect(resolveStackEntry("/repo/stacks", "dev", "unicas"))
      .toBe(join("/repo/stacks", "unicas", "local", "dev.mjs"));
    expect(resolveStackEntry("/repo/stacks", "deploy", "unidocs-azure"))
      .toBe(join("/repo/stacks", "unidocs-azure", "deploy", "deploy.mjs"));
  });

  it("rejects names that can escape the stacks directory", () => {
    expect(() => resolveStackEntry("/repo/stacks", "dev", "../outside"))
      .toThrow(/Invalid stack name/);
    expect(() => resolveStackEntry("/repo/stacks", "unknown", "unicas"))
      .toThrow(/Unknown stack action/);
  });

  it("dev without a stack falls back to the cloudflare stack", () => {
    // `pnpm dev` / `pnpm dev psd` / `pnpm dev --cas remote` —— 第一个 token
    // 不是栈名时，它属于下游（doc type、flag），整串原样转发。
    expect(resolveInvocation("dev", [], STACKS))
      .toEqual({ stack: DEFAULT_DEV_STACK, args: [] });
    expect(resolveInvocation("dev", ["psd"], STACKS))
      .toEqual({ stack: DEFAULT_DEV_STACK, args: ["psd"] });
    expect(resolveInvocation("dev", ["--cas", "remote"], STACKS))
      .toEqual({ stack: DEFAULT_DEV_STACK, args: ["--cas", "remote"] });
  });

  it("an explicit stack still wins and is not forwarded", () => {
    expect(resolveInvocation("dev", ["unidocs-azure", "markdown"], STACKS))
      .toEqual({ stack: "unidocs-azure", args: ["markdown"] });
    expect(resolveInvocation("dev", ["unicas"], STACKS))
      .toEqual({ stack: "unicas", args: [] });
  });

  it("deploy and smoke never guess a stack", () => {
    // 往默认栈上静默部署是不能接受的 —— 缺栈名就是缺栈名。
    expect(resolveInvocation("deploy", [], STACKS))
      .toEqual({ stack: undefined, args: [] });
    expect(resolveInvocation("smoke", ["psd"], STACKS))
      .toEqual({ stack: undefined, args: ["psd"] });
    expect(resolveInvocation("deploy", ["unidocs-azure"], STACKS))
      .toEqual({ stack: "unidocs-azure", args: [] });
  });

  it("默认栈是真实存在的一个栈", async () => {
    await expect(listStacks()).resolves.toContain(DEFAULT_DEV_STACK);
  });

  it("discovers only conventionally named stack directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "unidocs-stacks-"));
    await Promise.all([
      mkdir(join(root, "unicas")),
      mkdir(join(root, "unidocs-azure")),
      mkdir(join(root, "Not-A-Stack")),
    ]);
    await expect(listStacks(root)).resolves.toEqual(["unicas", "unidocs-azure"]);
  });
});