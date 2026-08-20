import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encode } from "fast-png";
import { compareToComposite } from "./support/fidelity.js";

/**
 * Fidelity regression suite. The standard we compare against is Photoshop's
 * own composite baked into each PSD (see support/fidelity.ts). A dropped
 * format (blend mode, fillOpacity, an effect, an adjustment) pushes the pixel
 * error above the file's recorded ceiling and fails here — so a fidelity loss
 * is caught automatically instead of by eyeballing exports one by one.
 *
 * Ceilings are set a little above the measured error, with headroom, so noise
 * doesn't flake but a real regression (which moves the number a lot) trips it.
 * When you legitimately improve fidelity, ratchet the ceiling DOWN to lock it.
 *
 * Committed fixtures always run (CI-stable). Large real-world PSDs live outside
 * the repo; list them here and they run when present, skip-with-note otherwise.
 * Point PSD_FIDELITY_DIFFS at a directory to also dump diff heatmaps.
 */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const diffDir = process.env.PSD_FIDELITY_DIFFS;

interface Target { name: string; path: string; maxMean: number; maxPctOff: number; committed?: boolean }

const TARGETS: Target[] = [
  // Committed oracle: independent hand-computed composite → must be exact.
  { name: "sample", path: fixture("sample.psd"), maxMean: 0.5, maxPctOff: 0.001, committed: true },
  // Real Photoshop files (user's machine). Baselines measured 2026-08-20.
  // landing: after rendering the red drop shadow the residual is just stroke
  // anti-aliasing (mean 0.11 / 0.43%); ceiling ratcheted down to lock that in.
  { name: "landing", path: "/Users/yanjiayi/Downloads/landing-page-capture-yourself-theme/4414025.psd", maxMean: 0.2, maxPctOff: 0.006 },
  { name: "fashion", path: "/Users/yanjiayi/Downloads/fashion-typography-banner-template/5319340.psd", maxMean: 0.3, maxPctOff: 0.005 },
];

describe("render fidelity vs Photoshop composite", () => {
  for (const t of TARGETS) {
    const present = existsSync(t.path);
    const run = present ? it : it.skip;
    run(`${t.name}: within recorded error ceiling`, async () => {
      let diff: { width: number; height: number; data: Uint8ClampedArray } | null = null;
      const r = await compareToComposite(new Uint8Array(readFileSync(t.path)), {
        tol: 12,
        diffOut: diffDir ? (px) => { diff = px; } : undefined,
      });
      // eslint-disable-next-line no-console
      console.log(`[fidelity] ${t.name}: mean=${r.meanErr.toFixed(3)} max=${r.maxErr} pctOff=${(r.pctOff * 100).toFixed(2)}% (${r.width}x${r.height})`);
      if (diff && diffDir) writeFileSync(`${diffDir}/diff-${t.name}.png`, encode({ width: diff.width, height: diff.height, data: diff.data, channels: 4, depth: 8 }));

      expect(r.hasComposite).toBe(true);
      expect(r.meanErr).toBeLessThanOrEqual(t.maxMean);
      expect(r.pctOff).toBeLessThanOrEqual(t.maxPctOff);
    }, 180000);
    if (!present && !t.committed) {
      // eslint-disable-next-line no-console
      console.log(`[fidelity] ${t.name}: SKIPPED (not found at ${t.path})`);
    }
  }
});
