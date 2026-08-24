#!/usr/bin/env node
/**
 * Compute a UniDocs CAS node hash from stdin.
 *
 * Usage: node scripts/cas-digest.mjs <contentType> [refsCsv] < content
 * Prints the 64-char hex hash to stdout.
 */

import { readFileSync } from "node:fs";
import {
  encodeHeader,
  computeNodeDigest,
  hashToHex,
  hexToHash,
} from "../packages/cas-server-common/dist/index.js";

const contentType = process.argv[2];
if (!contentType) {
  console.error("usage: node scripts/cas-digest.mjs <contentType> [refsCsv]");
  process.exit(1);
}

const refs = (process.argv[3] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const content = new Uint8Array(readFileSync(0));
const header = encodeHeader(content.length, contentType, refs.length);
const digest = await computeNodeDigest(header, contentType, refs.map(hexToHash), content);
process.stdout.write(hashToHex(digest));
