import {
  buildPossessionChallenge as serviceBuildPossessionChallenge,
  verifyPossessionProof as serviceVerifyPossessionProof,
} from "@unicas/service";
import { describe, expect, test } from "vitest";
import {
  buildPossessionChallenge,
  verifyPossessionProof,
} from "../src/index.js";

describe("control-plane possession compatibility", () => {
  test("re-exports the service helpers", () => {
    expect(buildPossessionChallenge).toBe(serviceBuildPossessionChallenge);
    expect(verifyPossessionProof).toBe(serviceVerifyPossessionProof);
  });
});
