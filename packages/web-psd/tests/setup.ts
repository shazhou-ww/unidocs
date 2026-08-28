import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetState } from "../src/ui/store.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // src/ui/store.ts's `state` is a module-level singleton, and vitest
  // isolates test *files*, not individual `it()` blocks — without this,
  // every test in a file shares one mutable store and a later test can
  // silently inherit a field a prior test left mutated.
  resetState();
});
