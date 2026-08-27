import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listStacks, STACK_ACTION_ENTRIES } from "../../../scripts/run-stack.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STACKS_ROOT = join(ROOT, "stacks");

describe("stack layout contract", () => {
  it("provides every conventional action entry for each registered stack", async () => {
    const stacks = await listStacks(STACKS_ROOT);
    expect(stacks).toEqual(["unicas", "unidocs-azure", "unidocs-cloudflare"]);
    await Promise.all(stacks.flatMap((stack) =>
      Object.values(STACK_ACTION_ENTRIES).map((parts) =>
        expect(access(join(STACKS_ROOT, stack, ...parts))).resolves.toBeUndefined(),
      ),
    ));
  });
});