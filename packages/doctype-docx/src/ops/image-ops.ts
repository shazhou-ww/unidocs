/**
 * Image operations for DOCX documents.
 *
 * All operations use the library's internal APIs to manipulate OOXML
 * structures directly (w:drawing, wp:inline, wp:extent, etc.).
 */

import type { Document } from "@ariadng/office/docx";
import type { SBlob, SBlobData } from "@unidocs/protocol";
import type { XmlElement } from "@ariadng/office/xml";

// ─── OOXML namespace URIs (standard constants) ──────────────────────
const WML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Find the a:blip element (depth-first search).
 */
function findBlip(el: XmlElement): XmlElement | undefined {
  for (const child of el.children) {
    if (child.kind !== "element") continue;
    if (child.localName === "blip" && child.namespaceUri() === A_NS) {
      return child;
    }
    const nested = findBlip(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Recursively collect all (wp:inline | wp:anchor) containers in document
 * order, matching the traversal used by the library's listImages().
 */
function collectImageContainers(
  body: XmlElement,
): { container: XmlElement; run: XmlElement }[] {
  const results: { container: XmlElement; run: XmlElement }[] = [];

  function walk(el: XmlElement): void {
    for (const child of el.children) {
      if (child.kind !== "element") continue;

      if (child.localName === "drawing" && child.namespaceUri() === WML_NS) {
        for (const drawingChild of child.children) {
          if (drawingChild.kind !== "element") continue;
          if (drawingChild.namespaceUri() !== WP_NS) continue;
          if (drawingChild.localName !== "inline" && drawingChild.localName !== "anchor")
            continue;

          // Verify this container has a valid blip (matches listImages behavior)
          const blip = findBlip(drawingChild);
          if (!blip) continue;
          const relId = blip.getAttributeNs(R_NS, "embed");
          if (relId === undefined) continue;

          results.push({ container: drawingChild, run: el });
        }
        continue;
      }

      walk(child);
    }
  }

  walk(body);
  return results;
}

// ─── Operations ─────────────────────────────────────────────────────

/**
 * Insert an inline image at the end of the document.
 */
export async function insertImage(
  document: Document,
  payload: { blob: SBlob; widthPx?: number; altText?: string },
  readSBlob: (blob: SBlob) => Promise<SBlobData>,
): Promise<void> {
  const stored = await readSBlob(payload.blob);
  document.addImage(stored.data, {
    widthPx: payload.widthPx,
    altText: payload.altText,
  });
}

/**
 * Delete an image by its index.
 */
export function deleteImage(document: Document, index: number): void {
  const di = document._internal();
  const containers = collectImageContainers(di.body());

  if (index < 0 || index >= containers.length) {
    throw new RangeError(`Image index ${index} out of range (0-${containers.length - 1})`);
  }

  const { run } = containers[index];
  const parent = run.parent;
  if (parent) {
    parent.removeChild(run);
  }

  di.markDirty(di.main);
}

/**
 * Replace an image's bytes with new content from CAS.
 */
export async function replaceImage(
  document: Document,
  index: number,
  blob: SBlob,
  readSBlob: (blob: SBlob) => Promise<SBlobData>,
): Promise<void> {
  const di = document._internal();
  const images = document.images();

  if (index < 0 || index >= images.length) {
    throw new RangeError(`Image index ${index} out of range (0-${images.length - 1})`);
  }

  // Read new bytes from CAS
  const newBytes = (await readSBlob(blob)).data;

  // Get the media part and overwrite
  const part = di.office.package.getPart(images[index].partName);
  if (!part) {
    throw new Error(`Media part not found: ${images[index].partName}`);
  }

  part.write(newBytes);
  di.markDirty(di.main);
}

/**
 * Set the display size of an image (in EMU).
 */
export function setImageSize(
  document: Document,
  index: number,
  widthEmu?: number,
  heightEmu?: number,
): void {
  if (widthEmu === undefined && heightEmu === undefined) {
    return;
  }

  const di = document._internal();
  const containers = collectImageContainers(di.body());

  if (index < 0 || index >= containers.length) {
    throw new RangeError(`Image index ${index} out of range (0-${containers.length - 1})`);
  }

  const { container } = containers[index];

  // Update wp:extent (cx/cy)
  const extent = container.find(WP_NS, "extent");
  if (extent) {
    if (widthEmu !== undefined) extent.setAttribute("cx", String(widthEmu));
    if (heightEmu !== undefined) extent.setAttribute("cy", String(heightEmu));
  }

  // Update a:ext inside pic:pic/pic:spPr/a:xfrm
  const picExtent = findPictureExtent(container);
  if (picExtent) {
    if (widthEmu !== undefined) picExtent.setAttribute("cx", String(widthEmu));
    if (heightEmu !== undefined) picExtent.setAttribute("cy", String(heightEmu));
  }

  di.markDirty(di.main);
}

/**
 * Set the alt text (description) of an image.
 */
export function setImageAltText(document: Document, index: number, altText: string): void {
  const di = document._internal();
  const containers = collectImageContainers(di.body());

  if (index < 0 || index >= containers.length) {
    throw new RangeError(`Image index ${index} out of range (0-${containers.length - 1})`);
  }

  const { container } = containers[index];
  const docPr = container.find(WP_NS, "docPr");
  if (docPr) {
    docPr.setAttribute("descr", altText);
  }

  di.markDirty(di.main);
}

/**
 * Find the a:ext element inside pic:pic/pic:spPr/a:xfrm.
 */
function findPictureExtent(container: XmlElement): XmlElement | undefined {
  const graphic = container.find(A_NS, "graphic");
  if (!graphic) return undefined;
  const graphicData = graphic.find(A_NS, "graphicData");
  if (!graphicData) return undefined;
  const pic = graphicData.find(PIC_NS, "pic");
  if (!pic) return undefined;
  const spPr = pic.find(PIC_NS, "spPr");
  if (!spPr) return undefined;
  const xfrm = spPr.find(A_NS, "xfrm");
  if (!xfrm) return undefined;
  return xfrm.find(A_NS, "ext");
}
