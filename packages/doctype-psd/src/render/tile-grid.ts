type Rect = [number, number, number, number]; // [top,left,bottom,right]

export type Tile = { tx: number; ty: number; region: Rect };

export const tileKey = (tx: number, ty: number): string => `${tx},${ty}`;

export function allTiles(canvas: { width: number; height: number }, tileSize: number): Tile[] {
  const out: Tile[] = [];
  const cols = Math.ceil(canvas.width / tileSize);
  const rows = Math.ceil(canvas.height / tileSize);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const top = ty * tileSize, left = tx * tileSize;
      out.push({ tx, ty, region: [top, left, Math.min(canvas.height, top + tileSize), Math.min(canvas.width, left + tileSize)] });
    }
  }
  return out;
}

export function tilesForRect(canvas: { width: number; height: number }, tileSize: number, rect: Rect): Tile[] {
  const [rt, rl, rb, rr] = rect;
  // Clamp the rect to the canvas; empty if degenerate/off-canvas.
  const t = Math.max(0, rt), l = Math.max(0, rl);
  const b = Math.min(canvas.height, rb), r = Math.min(canvas.width, rr);
  if (b <= t || r <= l) return [];
  const tx0 = Math.floor(l / tileSize), tx1 = Math.floor((r - 1) / tileSize);
  const ty0 = Math.floor(t / tileSize), ty1 = Math.floor((b - 1) / tileSize);
  const out: Tile[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const top = ty * tileSize, left = tx * tileSize;
      out.push({ tx, ty, region: [top, left, Math.min(canvas.height, top + tileSize), Math.min(canvas.width, left + tileSize)] });
    }
  }
  return out;
}
