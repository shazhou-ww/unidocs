import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listStacks,
  resolveStackEntry,
  STACK_ACTION_ENTRIES,
} from "../../../scripts/run-stack.mjs";

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