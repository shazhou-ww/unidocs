import { describe, expect, test, vi } from "vitest";
import { main } from "../src/cli.js";

describe("cli dispatch", () => {
  test("prints help for `unicas help`", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await main(["help"]);
    } finally {
      spy.mockRestore();
    }
    const output = writes.join("");
    expect(output).toContain("unicas login");
    expect(output).toContain("unicas mcp");
    expect(output).toContain("unicas stacks create");
  });

  test("prints help when invoked without arguments", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await main([]);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain("unicas login");
  });

  test("rejects an unknown command", async () => {
    await expect(main(["frobnicate"])).rejects.toThrow(/unknown command 'frobnicate'/);
  });
});
