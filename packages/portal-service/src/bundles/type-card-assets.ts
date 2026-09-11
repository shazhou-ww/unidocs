import { XMLParser, XMLValidator } from "fast-xml-parser";
import { BundleZipError } from "./zip.js";

export interface TypeCardAssetInfo {
  readonly contentType: "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp";
  readonly width: number | null;
  readonly height: number | null;
}

const maxDimension = 4096;
const maxPixels = 16_777_216;

function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > maxDimension || height > maxDimension || width * height > maxPixels) throw new BundleZipError();
  return { width, height };
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function crc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngInfo(bytes: Uint8Array): TypeCardAssetInfo {
  if (bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new BundleZipError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let size: { width: number; height: number } | null = null;
  let sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) throw new BundleZipError();
    const type = ascii(bytes, offset + 4, 4);
    if (view.getUint32(offset + 8 + length) !== crc32(bytes, offset + 4, offset + 8 + length)) throw new BundleZipError();
    if (offset === 8 && (type !== "IHDR" || length !== 13)) throw new BundleZipError();
    if (type === "IHDR") {
      if (size) throw new BundleZipError();
      size = dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)
        || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || ![0, 1].includes(bytes[offset + 20])) throw new BundleZipError();
    }
    if (type === "IDAT") sawData = true;
    if (type === "IEND") {
      if (length !== 0 || !size || !sawData || chunkEnd !== bytes.length) throw new BundleZipError();
      return { contentType: "image/png", ...size };
    }
    offset = chunkEnd;
  }
  throw new BundleZipError();
}

function jpegInfo(bytes: Uint8Array): TypeCardAssetInfo {
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new BundleZipError();
  let offset = 2;
  let size: { width: number; height: number } | null = null;
  while (offset + 4 <= bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw new BundleZipError();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xda) break;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new BundleZipError();
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length - 2) throw new BundleZipError();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || size) throw new BundleZipError();
      size = dimensions((bytes[offset + 5] << 8) | bytes[offset + 6], (bytes[offset + 3] << 8) | bytes[offset + 4]);
    }
    offset += length;
  }
  if (!size) throw new BundleZipError();
  return { contentType: "image/jpeg", ...size };
}

function webpInfo(bytes: Uint8Array): TypeCardAssetInfo {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") throw new BundleZipError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) throw new BundleZipError();
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + length > bytes.length) throw new BundleZipError();
    if (type === "VP8X" && length >= 10) {
      const size = dimensions(1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16), 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16));
      return { contentType: "image/webp", ...size };
    }
    if (type === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
      const bits = view.getUint32(data + 1, true);
      const size = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      return { contentType: "image/webp", ...size };
    }
    if (type === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      const size = dimensions(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff);
      return { contentType: "image/webp", ...size };
    }
    offset = data + length + (length % 2);
  }
  throw new BundleZipError();
}

const allowedElements = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc"]);
const allowedAttributes = new Set(["@_xmlns", "@_viewBox", "@_width", "@_height", "@_fill", "@_stroke", "@_stroke-width", "@_stroke-linecap", "@_stroke-linejoin", "@_stroke-miterlimit", "@_stroke-dasharray", "@_stroke-dashoffset", "@_fill-rule", "@_clip-rule", "@_opacity", "@_fill-opacity", "@_stroke-opacity", "@_transform", "@_d", "@_x", "@_y", "@_x1", "@_y1", "@_x2", "@_y2", "@_cx", "@_cy", "@_r", "@_rx", "@_ry", "@_points", "@_id", "@_offset", "@_stop-color", "@_stop-opacity", "@_gradientUnits", "@_gradientTransform", "@_clip-path", "@_mask"]);

function svgInfo(bytes: Uint8Array): TypeCardAssetInfo {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.length > 262_144 || /<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new BundleZipError();
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: false, allowBooleanAttributes: false, parseAttributeValue: false }).parse(text) as Record<string, unknown>;
  if (!parsed.svg || Object.keys(parsed).some(key => key !== "?xml" && key !== "svg")) throw new BundleZipError();
  if (typeof parsed.svg !== "object" || (parsed.svg as Record<string, unknown>)["@_xmlns"] !== "http://www.w3.org/2000/svg") throw new BundleZipError();
  const visit = (value: unknown, element: string) => {
    if (!allowedElements.has(element)) throw new BundleZipError();
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "#text") continue;
      if (key.startsWith("@_")) {
        if (!allowedAttributes.has(key) || typeof child !== "string" && typeof child !== "number") throw new BundleZipError();
        const attribute = String(child);
        if (key === "@_xmlns") {
          if (attribute !== "http://www.w3.org/2000/svg") throw new BundleZipError();
        } else if (key === "@_clip-path" || key === "@_mask") {
          if (!/^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/.test(attribute)) throw new BundleZipError();
        } else if (/url\s*\(|javascript:|https?:|data:/i.test(attribute)) throw new BundleZipError();
      } else if (Array.isArray(child)) child.forEach(item => visit(item, key));
      else visit(child, key);
    }
  };
  visit(parsed.svg, "svg");
  return { contentType: "image/svg+xml", width: null, height: null };
}

export function inspectTypeCardAsset(path: string, bytes: Uint8Array): TypeCardAssetInfo {
  if (path.endsWith(".png")) return pngInfo(bytes);
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return jpegInfo(bytes);
  if (path.endsWith(".webp")) return webpInfo(bytes);
  if (path.endsWith(".svg")) return svgInfo(bytes);
  throw new BundleZipError();
}