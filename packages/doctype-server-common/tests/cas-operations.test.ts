import { describe, expect, it, vi } from "vitest";
import { CasClientError } from "@unicas/client";
import { createSBlob } from "@unidocs/svalue-codec";
import { commitRootRefsOrRollback, leaseOpRefs } from "../src/cas-operations.js";

describe("leaseOpRefs", () => {
  it("leases each aggregated hash and skips empty maps", async () => {
    const leaseNode = vi.fn(async () => ({ ready: true }));
    const hash = "d".repeat(64);
    const refs = await leaseOpRefs(
      [{ kind: "insertImage", blob: createSBlob(hash) }, { kind: "appendParagraph" }],
      { leaseNode },
    );
    expect(refs).toEqual({ [hash]: 1 });
    expect(leaseNode).toHaveBeenCalledTimes(1);
    expect(leaseNode).toHaveBeenCalledWith(hash);
  });

  it("preserves missing-node client errors", async () => {
    const leaseNode = vi.fn(async () => {
      throw new CasClientError(404, "Not Found", "lease");
    });
    await expect(leaseOpRefs(
      [{ blob: createSBlob("e".repeat(64)) }],
      { leaseNode },
    )).rejects.toMatchObject({ status: 404 });
  });
});

describe("commitRootRefsOrRollback", () => {
  it("skips empty changes", async () => {
    const updateRootRefs = vi.fn();
    const rollback = vi.fn();
    await commitRootRefsOrRollback({ updateRootRefs }, "id", {}, rollback);
    expect(updateRootRefs).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back the delta when root refs fail", async () => {
    const updateRootRefs = vi.fn(async () => {
      throw new CasClientError(500, "Internal Server Error", "updateRootRefs");
    });
    const rollback = vi.fn();
    const hash = "f".repeat(64);
    await expect(commitRootRefsOrRollback(
      { updateRootRefs },
      "apply:u:d:2",
      { [hash]: 1 },
      rollback,
    )).rejects.toThrow(/updateRootRefs/);
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});
