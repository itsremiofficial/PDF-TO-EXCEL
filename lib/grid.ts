// Table-grid inference from a rendered page.
// Pure typed-array maths with no DOM access, so this is safe to move into a
// worker later without changes.

export interface Run {
  s: number;
  e: number;
}
export interface Column {
  x0: number;
  x1: number;
}
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Grid {
  thr: number;
  ink: Uint8Array;
  rows: Run[];
  columns: Column[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  textH: number;
}

export function otsu(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) {
      best = v;
      thr = t;
    }
  }
  return thr;
}

export function toGray(rgba: Uint8ClampedArray, W: number, H: number): Uint8Array {
  const g = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    g[p] = ((rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000) | 0;
  }
  return g;
}

/** Maximal runs where hit(i) holds; runs closer together than minGap are merged. */
export function mergedRuns(from: number, to: number, hit: (i: number) => boolean, minGap: number): Run[] {
  const raw: Run[] = [];
  let cur: Run | null = null;
  for (let i = from; i <= to; i++) {
    if (hit(i)) {
      if (cur) cur.e = i;
      else cur = { s: i, e: i };
    } else if (cur) {
      raw.push(cur);
      cur = null;
    }
  }
  if (cur) raw.push(cur);

  const out: Run[] = [];
  for (const r of raw) {
    const p = out[out.length - 1];
    if (p && r.s - p.e - 1 < minGap) p.e = r.e;
    else out.push({ s: r.s, e: r.e });
  }
  return out;
}

export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

export interface GridOptions {
  ruleRatio?: number;
  maxRuleHeight?: number;
  minRowGap?: number;
  minRowHeight?: number;
  /** Minimum gutter width, in multiples of text height. Lower splits more. */
  gutterFactor?: number;
  /** Fraction of rows allowed to have ink inside a gutter. */
  gutterRowTol?: number;
}

/**
 * Infer rows and columns for the table inside `region`.
 *
 * Screenshot tables defeat a naive whitespace projection in two ways, both
 * handled here before anything is measured:
 *
 *   - Full-width ruled separators put ink into every column, so no gutter ever
 *     reads as blank. Hairlines are erased.
 *   - A solid-filled header row is inverted: its light glyphs read as
 *     background and its fill reads as ink. Those bands are flipped in place.
 *
 * Columns then come from a per-x count of how many rows place ink there, with a
 * small tolerance so one overlong value cannot erase a boundary the rest of the
 * table agrees on. See the column section for why that tolerance matters.
 */
export function analyse(
  gray: Uint8Array,
  W: number,
  H: number,
  region: Region,
  opts: GridOptions = {},
): Grid {
  const { x: rx, y: ry, w: rw, h: rh } = region;

  const sub = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const src = (ry + y) * W + rx;
    sub.set(gray.subarray(src, src + rw), y * rw);
  }
  const thr = otsu(sub);
  const ink = new Uint8Array(rw * rh);
  for (let p = 0; p < rw * rh; p++) ink[p] = sub[p] < thr ? 1 : 0;

  const empty: Grid = { thr, ink, rows: [], columns: [], minX: 0, maxX: 0, minY: 0, maxY: 0, textH: 0 };

  // --- content bounds -----------------------------------------------------
  let minX = rw;
  let maxX = -1;
  let minY = rh;
  let maxY = -1;
  const rowInk = new Uint32Array(rh);
  for (let y = 0; y < rh; y++) {
    const off = y * rw;
    let c = 0;
    for (let x = 0; x < rw; x++) {
      if (ink[off + x]) {
        c++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    rowInk[y] = c;
    if (c) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return empty;
  const bandW = maxX - minX + 1;

  // --- rules erased, filled bands inverted --------------------------------
  for (const b of mergedRuns(minY, maxY, (y) => rowInk[y] >= bandW * (opts.ruleRatio ?? 0.6), 3)) {
    if (b.e - b.s + 1 <= (opts.maxRuleHeight ?? 8)) {
      for (let y = b.s; y <= b.e; y++) ink.fill(0, y * rw, y * rw + rw);
    } else {
      for (let y = b.s; y <= b.e; y++) {
        const off = y * rw;
        for (let x = minX; x <= maxX; x++) ink[off + x] ^= 1;
      }
    }
  }

  // --- rows ---------------------------------------------------------------
  const rowInk2 = new Uint32Array(rh);
  for (let y = minY; y <= maxY; y++) {
    const off = y * rw;
    let c = 0;
    for (let x = minX; x <= maxX; x++) if (ink[off + x]) c++;
    rowInk2[y] = c;
  }
  const rows = mergedRuns(minY, maxY, (y) => rowInk2[y] > bandW * 0.002, opts.minRowGap ?? 5).filter(
    (b) => b.e - b.s + 1 >= (opts.minRowHeight ?? 5),
  );
  if (!rows.length) return empty;

  // Text height anchors the gap thresholds, keeping them resolution-free.
  const textH = median(rows.map((r) => r.e - r.s + 1)) || 12;

  // --- columns ------------------------------------------------------------
  // For each x, count how many rows put ink there. A column separator is a
  // band where that count stays near zero down the whole table.
  //
  // Near zero rather than exactly zero, and that distinction carries the whole
  // algorithm: a single overlong value — a filename overhanging its column —
  // otherwise erases a separator that forty other rows agree on. Requiring a
  // perfectly blank gutter finds only about three quarters of the real
  // boundaries; letting a couple of rows dissent finds all of them.
  const hitRows = new Uint32Array(rw);
  for (const b of rows) {
    const s = Math.min(b.s + 1, b.e);
    const e = Math.max(b.e - 1, b.s);
    const seen = new Uint8Array(rw);
    for (let y = s; y <= e; y++) {
      const off = y * rw;
      for (let x = minX; x <= maxX; x++) if (ink[off + x]) seen[x] = 1;
    }
    for (let x = minX; x <= maxX; x++) if (seen[x]) hitRows[x]++;
  }

  // The width threshold is expressed in text heights so it survives a change of
  // resolution or font size: spaces between words inside a cell stay well under
  // one line height, while real gutters comfortably clear it.
  const tol = Math.max(1, Math.floor(rows.length * (opts.gutterRowTol ?? 0.05)));
  const minGutter = Math.max(4, Math.round(textH * (opts.gutterFactor ?? 1.2)));
  const splits = mergedRuns(minX, maxX, (x) => hitRows[x] <= tol, 1)
    .filter((g) => g.e - g.s + 1 >= minGutter && g.s > minX && g.e < maxX)
    .map((g) => Math.round((g.s + g.e) / 2));

  const bounds = [minX, ...new Set(splits), maxX + 1];
  const columns: Column[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 2) columns.push({ x0: bounds[i], x1: bounds[i + 1] });
  }

  return { thr, ink, rows, columns, minX, maxX, minY, maxY, textH };
}

/**
 * Best-effort guess at which part of a page holds the table.
 *
 * A screenshot wraps its table in navbars, sidebars and toolbars, so the useful
 * landmark is the solid-filled strip that web tables almost always use for a
 * header row: it gives the left edge, right edge and top in one shot. This is a
 * starting point, not an answer — the caller is expected to show the result and
 * let the user drag it.
 */
export function guessTableRegion(gray: Uint8Array, W: number, H: number): Region {
  const whole: Region = { x: 0, y: 0, w: W, h: H };
  const thr = otsu(gray);

  const rowInk = new Int32Array(H);
  const rowX0 = new Int32Array(H);
  const rowX1 = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    const off = y * W;
    let c = 0;
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < W; x++) {
      if (gray[off + x] < thr) {
        c++;
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    rowInk[y] = c;
    rowX0[y] = x0;
    rowX1[y] = x1;
  }

  interface Band {
    s: number;
    e: number;
    xs0: number[];
    xs1: number[];
    x0: number;
    x1: number;
  }
  const filled: Band[] = [];
  let cur: Band | null = null;
  for (let y = 0; y < H; y++) {
    const span = rowX0[y] < 0 ? 0 : rowX1[y] - rowX0[y] + 1;
    const solid = span > W * 0.3 && rowInk[y] > span * 0.85;
    if (solid) {
      if (cur) {
        cur.e = y;
        cur.xs0.push(rowX0[y]);
        cur.xs1.push(rowX1[y]);
      } else {
        cur = { s: y, e: y, xs0: [rowX0[y]], xs1: [rowX1[y]], x0: 0, x1: 0 };
      }
    } else if (cur) {
      filled.push(cur);
      cur = null;
    }
  }
  if (cur) filled.push(cur);
  // Median edges rather than extremes: a single sidebar icon level with the
  // header would otherwise drag the region across half the page.
  for (const b of filled) {
    b.x0 = median(b.xs0);
    b.x1 = median(b.xs1);
  }

  // Skip hairline dividers and full-bleed page chrome such as a navbar.
  const cands = filled.filter((b) => b.e - b.s + 1 >= 6 && b.x1 - b.x0 + 1 < W * 0.985);
  if (!cands.length) return whole;

  const hdr = cands.sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))[0];
  const x0 = Math.max(0, hdr.x0 - 4);
  const x1 = Math.min(W - 1, hdr.x1 + 4);

  // Walk down while rows still sit inside the header's span, tolerating the
  // blank gaps between rows. The first sustained silence ends the table.
  const tol = Math.max(12, (x1 - x0) * 0.02);
  const maxBlank = Math.max(40, (hdr.e - hdr.s + 1) * 4);
  let lastSeen = hdr.e;
  let blank = 0;
  for (let y = hdr.e + 1; y < H; y++) {
    if (rowX0[y] >= 0 && rowX0[y] >= x0 - tol && rowX1[y] <= x1 + tol) {
      lastSeen = y;
      blank = 0;
    } else if (++blank > maxBlank) break;
  }

  const y0 = Math.max(0, hdr.s - 3);
  const y1 = Math.min(H - 1, lastSeen + 3);
  if (x1 - x0 < 40 || y1 - y0 < 20) return whole;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
