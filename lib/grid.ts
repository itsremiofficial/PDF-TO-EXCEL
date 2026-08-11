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

/**
 * Adaptive threshold using an integral image for fast local-mean computation.
 * Each pixel is classified as ink based on its local neighbourhood rather than
 * a single global threshold — critical for screenshots and scans with uneven
 * lighting, shadows, or mixed dark/light backgrounds.
 */
export function adaptiveThreshold(gray: Uint8Array, w: number, h: number, blockSize: number, C: number): Uint8Array {
  const ink = new Uint8Array(w * h);
  const half = blockSize >> 1;
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * iw + (x + 1)] = rowSum + integral[y * iw + (x + 1)];
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half);
      const y0 = Math.max(0, y - half);
      const x1 = Math.min(w - 1, x + half);
      const y1 = Math.min(h - 1, y + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      ink[y * w + x] = gray[y * w + x] < (sum / count - C) ? 1 : 0;
    }
  }
  return ink;
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

  // Try adaptive threshold first (better for uneven lighting), then fall back
  // to Otsu if grid detection fails — this guarantees the grid always works.
  function buildInk(threshold: number): Uint8Array {
    const ink = new Uint8Array(rw * rh);
    for (let p = 0; p < rw * rh; p++) ink[p] = sub[p] < threshold ? 1 : 0;
    return ink;
  }

  const adaptiveInk = (() => {
    const blockSize = Math.max(15, Math.round(Math.min(rw, rh) * 0.04) | 1);
    return adaptiveThreshold(sub, rw, rh, blockSize, 8);
  })();

  function detectGrid(ink: Uint8Array): Grid {
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
    const ruleRatio = opts.ruleRatio ?? 0.6;
    const maxRule = opts.maxRuleHeight ?? 8;
    const hRules: Run[] = [];
    for (const b of mergedRuns(minY, maxY, (y) => rowInk[y] >= bandW * ruleRatio, 3)) {
      if (b.e - b.s + 1 <= maxRule) {
        hRules.push(b);
        for (let y = b.s; y <= b.e; y++) ink.fill(0, y * rw, y * rw + rw);
      } else {
        for (let y = b.s; y <= b.e; y++) {
          const off = y * rw;
          for (let x = minX; x <= maxX; x++) ink[off + x] ^= 1;
        }
      }
    }

    // The same erasure transposed. A fully ruled table is the case where
    // leaving these in is fatal rather than untidy: a vertical rule puts ink in
    // every scanline, so every row runs into the next, and it splits each real
    // gutter into two halves too narrow to pass minGutter — which is how a
    // 33x20 table reads out as 4 rows and 2 columns. Being at most `maxRule`
    // wide while inked down most of the band is what separates a rule from a
    // narrow column of values.
    const colInk = new Uint32Array(rw);
    for (let y = minY; y <= maxY; y++) {
      const off = y * rw;
      for (let x = minX; x <= maxX; x++) if (ink[off + x]) colInk[x]++;
    }
    const bandH = maxY - minY + 1;
    const vRules: Run[] = [];
    for (const b of mergedRuns(minX, maxX, (x) => colInk[x] >= bandH * ruleRatio, 3)) {
      if (b.e - b.s + 1 > maxRule) continue;
      vRules.push(b);
      for (let y = minY; y <= maxY; y++) {
        const off = y * rw;
        for (let x = b.s; x <= b.e; x++) ink[off + x] = 0;
      }
    }

    /**
     * The spaces between consecutive rules — a ruled table's own cells. The
     * content edges act as rules too, so a table whose outermost border is
     * missing (or falls outside the region) still yields its first and last
     * cell instead of silently dropping a whole column of values.
     */
    const gaps = (rules: Run[], min: number, lo: number, hi: number): Run[] => {
      const bounds = [{ s: lo - 1, e: lo - 1 }, ...rules, { s: hi + 1, e: hi + 1 }];
      return bounds
        .slice(1)
        .map((r, i) => ({ s: bounds[i].e + 1, e: r.s - 1 }))
        .filter((g) => g.e - g.s + 1 >= min);
    };

    // --- rows ---------------------------------------------------------------
    const rowInk2 = new Uint32Array(rh);
    for (let y = minY; y <= maxY; y++) {
      const off = y * rw;
      let c = 0;
      for (let x = minX; x <= maxX; x++) if (ink[off + x]) c++;
      rowInk2[y] = c;
    }
    const minRowH = opts.minRowHeight ?? 5;
    // Where the page drew its own row separators, they beat a whitespace
    // projection: they survive a wrapped cell, a blank cell and touching rows,
    // all of which merge or drop rows in the projection.
    const ruledRows = gaps(hRules, minRowH, minY, maxY).filter((g) => {
      for (let y = g.s; y <= g.e; y++) if (rowInk2[y]) return true;
      return false;
    });
    /**
     * A ruled table can still omit a separator — this is common between a
     * header and the first record, which some tables draw as one box. A band
     * far taller than its neighbours is split again on its widest blank
     * scanlines. The gap has to stay large relative to the row pitch, or a
     * header whose label wraps onto three lines becomes three rows.
     */
    const splitTall = (bands: Run[]): Run[] => {
      const med = median(bands.map((b) => b.e - b.s + 1));
      if (!med) return bands;
      const out: Run[] = [];
      for (const b of bands) {
        if (b.e - b.s + 1 < med * 1.5) {
          out.push(b);
          continue;
        }
        // Same ink floor as the projection path: a checkbox or a border stub
        // reaching into the gap is a couple of pixels wide and must not count
        // as a line of text.
        const parts = mergedRuns(b.s, b.e, (y) => rowInk2[y] > bandW * 0.002, Math.round(med * 0.4)).filter(
          (p) => p.e - p.s + 1 >= minRowH,
        );
        out.push(...(parts.length > 1 ? parts : [b]));
      }
      return out;
    };

    /**
     * Drop an unruled strip at the very top or bottom that is nothing like a
     * row of this table. The edge sentinels in `gaps` deliberately admit that
     * strip, because it is a borderless last row often enough to be worth
     * having — but on a screenshot it is just as often the page footer sitting
     * inside the region. Only a band that starts at the content edge can be one
     * of these; anything bounded by a real rule is kept whatever its height.
     */
    const trimOuter = (bands: Run[]): Run[] => {
      if (bands.length < 4) return bands;
      const med = median(bands.map((b) => b.e - b.s + 1));
      const tall = (b: Run) => b.e - b.s + 1 > med * 1.5;
      const first = bands[0];
      const last = bands[bands.length - 1];
      return bands.slice(
        first.s === minY && tall(first) ? 1 : 0,
        last.e === maxY && tall(last) ? bands.length - 1 : bands.length,
      );
    };

    const rows =
      ruledRows.length >= 2
        ? trimOuter(splitTall(ruledRows))
        : mergedRuns(minY, maxY, (y) => rowInk2[y] > bandW * 0.002, opts.minRowGap ?? 5).filter(
            (b) => b.e - b.s + 1 >= minRowH,
          );
    if (!rows.length) return empty;

    // Text height anchors the gap thresholds, keeping them resolution-free. It
    // has to be the height of the ink, not of the row: a ruled row also carries
    // its cell padding, and this number picks the OCR upscale.
    const inkHeight = (r: Run) => {
      let s = -1;
      let e = -1;
      for (let y = r.s; y <= r.e; y++) {
        if (!rowInk2[y]) continue;
        if (s < 0) s = y;
        e = y;
      }
      return s < 0 ? 0 : e - s + 1;
    };
    const textH = median(rows.map(inkHeight).filter(Boolean)) || 12;

    // --- columns ------------------------------------------------------------
    const ruledCols = gaps(vRules, 3, minX, maxX).map((g) => ({ x0: g.s, x1: g.e + 1 }));
    if (ruledCols.length >= 2) {
      // Drawn boundaries are already exact, so none of the whitespace
      // machinery below (tolerance, minimum gutter, inward expansion) applies.
      return { thr, ink, rows, columns: ruledCols, minX, maxX, minY, maxY, textH };
    }

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

    // Expand each column inward by a few pixels so the gutter never clips the
    // first or last glyph of an adjacent cell — cheap insurance against silent
    // truncation that would otherwise tank OCR accuracy.
    const EXPAND = Math.max(2, Math.round(textH * 0.15));
    for (const col of columns) {
      col.x0 = Math.max(minX, col.x0 - EXPAND);
      col.x1 = Math.min(maxX + 1, col.x1 + EXPAND);
    }

    return { thr, ink, rows, columns, minX, maxX, minY, maxY, textH };
  }

  // Try adaptive threshold first (better OCR accuracy on uneven backgrounds),
  // then fall back to global Otsu if grid detection fails.
  const adaptive = detectGrid(adaptiveInk);
  if (adaptive.rows.length > 0 && adaptive.columns.length >= 2) return adaptive;
  return detectGrid(buildInk(thr));
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

  // Skip hairline dividers, full-bleed page chrome such as a navbar, and the
  // browser toolbar glued to the bottom of a screenshot. The last one is a dark
  // solid strip that otherwise wins the "widest band" contest and drags the
  // region down to the very bottom of the page, where no table exists.
  const cands = filled.filter(
    (b) => b.e - b.s + 1 >= 6 && b.x1 - b.x0 + 1 < W * 0.985 && b.s < H * 0.9,
  );

  if (cands.length) {
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
    if (x1 - x0 >= 40 && y1 - y0 >= 20) {
      return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  }

  // No qualifying header band (light header fills, cropped screenshots). The
  // whole page is a far better starting point than a random chrome strip — the
  // grid stage is robust on full pages and the caller shows the result for the
  // user to drag a tighter box around the table.
  return whole;
}
