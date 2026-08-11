'use client';

// Extension included so `node --test` can load this file directly; the bundler
// is happy either way.
import { analyse, median, mergedRuns, type Column, type Grid, type Region, type Run } from './grid.ts';
import type { RenderedPage, TextItem } from './pdf';

export type Charset = 'AUTO' | 'ALNUM' | 'DIGIT' | 'TEXT';

export const CHARSETS: Record<Charset, string> = {
  AUTO: '',
  TEXT: '',
  ALNUM: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/. ',
  DIGIT: '0123456789-,./ ',
};

export interface Cell {
  text: string;
  /** true when the readings disagreed or the value breaks its column's shape */
  unsure: boolean;
  /** Tesseract confidence 0-100; -1 for text-layer cells */
  confidence: number;
}

export interface Table {
  headers: string[];
  rows: Cell[][];
  source: 'text' | 'ocr';
}

export interface Progress {
  done: number;
  total: number;
  label: string;
}

const clean = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[|[\]{}()<>_.,;:!\s-]+|[|[\]{}()<>_,;:!\s]+$/g, '')
    .trim();

// ---------------------------------------------------------------------------
// Text-layer path — exact, no OCR
// ---------------------------------------------------------------------------

/**
 * Build the table straight from the PDF's own text. Rows come from clustering
 * baselines; columns reuse the header-gap ∩ data-gap rule from the raster path,
 * measured over text extents instead of pixels.
 */
export function extractFromText(
  items: TextItem[],
  region: Region,
  opts: { gutterFactor?: number; gutterRowTol?: number; grid?: Grid } = {},
): Table | null {
  const inside = items.filter(
    (t) => t.x1 > region.x && t.x0 < region.x + region.w && t.yMid > region.y && t.yMid < region.y + region.h,
  );
  if (inside.length < 8) return null;

  const h = median(inside.map((t) => t.height)) || 8;
  const sorted = [...inside].sort((a, b) => a.yMid - b.yMid);
  const lines: TextItem[][] = [];
  let cur: TextItem[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].yMid - cur[cur.length - 1].yMid <= h * 0.6) cur.push(sorted[i]);
    else {
      lines.push(cur);
      cur = [sorted[i]];
    }
  }
  lines.push(cur);
  if (lines.length < 2) return null;

  const x0 = Math.floor(Math.min(...inside.map((t) => t.x0)));
  const x1 = Math.ceil(Math.max(...inside.map((t) => t.x1)));
  const W = x1 - x0 + 1;

  // Same rule as the raster path: count how many lines occupy each x, and treat
  // a band that almost nobody occupies as a separator. The tolerance is what
  // lets a single overlong value coexist with a real column boundary.
  const hits = new Uint32Array(W);
  for (const l of lines) {
    const seen = new Uint8Array(W);
    for (const t of l) {
      const a = Math.max(x0, Math.floor(t.x0));
      const b = Math.min(x1, Math.ceil(t.x1));
      for (let x = a; x <= b; x++) seen[x - x0] = 1;
    }
    for (let i = 0; i < W; i++) if (seen[i]) hits[i]++;
  }

  const tol = Math.max(1, Math.floor(lines.length * (opts.gutterRowTol ?? 0.05)));
  const minGutter = Math.max(2, h * (opts.gutterFactor ?? 1.2));
  const splits = mergedRuns(0, W - 1, (i) => hits[i] <= tol, 1)
    .filter((g) => g.e - g.s + 1 >= minGutter && g.s > 0 && g.e < W - 1)
    .map((g) => Math.round((g.s + g.e) / 2) + x0);

  const bounds = [x0, ...new Set(splits), x1 + 1];
  const gutterCols: Column[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 1) gutterCols.push({ x0: bounds[i], x1: bounds[i + 1] });
  }

  // Boundaries the page drew itself beat boundaries inferred from whitespace:
  // two columns whose values never collide (a row number beside a transaction
  // id) leave no gutter to find, and merge into one column of "1 230920".
  // grid.columns are region-relative; text items are in page coordinates.
  const ruled = (opts.grid?.columns ?? [])
    .map((c) => ({ x0: c.x0 + region.x, x1: c.x1 + region.x }))
    .filter((c) => c.x1 > x0 && c.x0 <= x1);
  const columns = ruled.length >= gutterCols.length && ruled.length >= 2 ? ruled : gutterCols;
  if (columns.length < 2) return null;

  const toRow = (line: TextItem[]) =>
    columns.map((c) => {
      const hits = line
        .filter((t) => (t.x0 + t.x1) / 2 >= c.x0 && (t.x0 + t.x1) / 2 < c.x1)
        .sort((a, b) => a.x0 - b.x0);
      return { text: clean(hits.map((t) => t.str).join(' ')), unsure: false, confidence: -1 };
    });

  const body = lines.map(toRow);

  // A page title, a toolbar or a footer button strip is a line that lands in
  // one or two columns while the table's own lines fill most of them. Dropping
  // those off each end is what stops the title from being read as the header
  // row, which then pushes every real header down into the data.
  const filled = (r: Cell[]) => r.filter((c) => c.text).length / columns.length;
  const wide = body.map(filled).filter((f) => f >= 0.6).length;
  if (wide >= 2) {
    while (body.length > 2 && filled(body[0]) < 0.3) body.shift();
    while (body.length > 2 && filled(body[body.length - 1]) < 0.3) body.pop();
  }

  return {
    headers: body[0].map((c) => c.text),
    rows: body.slice(1),
    source: 'text',
  };
}

// ---------------------------------------------------------------------------
// OCR path
// ---------------------------------------------------------------------------

/** A binarised, rule-free, header-corrected copy of the region for Tesseract. */
function toCleanCanvas(grid: Grid, region: Region): HTMLCanvasElement {
  const { w, h } = region;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    const v = grid.ink[p] ? 0 : 255;
    img.data[p * 4] = v;
    img.data[p * 4 + 1] = v;
    img.data[p * 4 + 2] = v;
    img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

const PAD = 14;

/** Glyph height Tesseract's LSTM was trained around. */
const TARGET_GLYPH_H = 32;

interface Box {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** Tight bounding box of a cell's ink, or null when the cell is blank. */
function cellBox(grid: Grid, regionW: number, r: Run, c: Column): Box | null {
  let x0 = c.x1;
  let x1 = c.x0 - 1;
  let y0 = r.e;
  let y1 = r.s - 1;
  for (let y = r.s; y <= r.e; y++) {
    const off = y * regionW;
    for (let x = c.x0; x < c.x1; x++) {
      if (grid.ink[off + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0) return null;
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Scale that puts a line of text at Tesseract's trained size.
 *
 * A fixed 4x is right only for one input resolution: on an already-large scan
 * it produced 120px glyphs, paying nine times the pixels for a read that is no
 * better. But the reference has to be the grid's median row height, not the
 * cell's own ink box — a cell wrapping onto two lines has twice the box height
 * and would otherwise be scaled to half the size it needs, which is exactly
 * where a per-cell rule reads worse than the fixed one it replaced.
 */
function scaleFor(box: Box, textH: number): number {
  const ref = textH > 0 ? textH : box.h;
  const s = TARGET_GLYPH_H / Math.max(1, ref);
  return Math.max(2, Math.min(6, Math.round(s * 2) / 2));
}

/**
 * Crop one cell, trimmed to its ink and upscaled. The trim keeps the upscale
 * spending pixels on glyphs rather than on cell padding. `cv` is reused across
 * cells by one worker lane — allocating a canvas per cell per scale was a
 * measurable share of the total for a large table.
 */
function drawCell(
  cv: HTMLCanvasElement,
  src: HTMLCanvasElement,
  box: Box,
  scale: number,
): HTMLCanvasElement {
  cv.width = Math.round((box.w + PAD * 2) * scale);
  cv.height = Math.round((box.h + PAD * 2) * scale);
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  // Nearest-neighbour on an already-binarised source: interpolation would add
  // grey edges that Tesseract's own thresholding then has to guess about.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    src,
    box.x0,
    box.y0,
    box.w,
    box.h,
    Math.round(PAD * scale),
    Math.round(PAD * scale),
    Math.round(box.w * scale),
    Math.round(box.h * scale),
  );
  return cv;
}

type Worker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

// A worker pool costs ~1-3s to spin up: each worker fetches the wasm core and
// the eng traineddata before it can read a single cell. Creating and tearing
// one down per extraction meant paying that on every re-read of an adjusted
// region. Cache it for the life of the page instead; releaseOcrPool() is there
// for callers that want the memory back.
let poolPromise: Promise<Worker[]> | null = null;

function wantedPoolSize(): number {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  // Leave a core for the UI thread; Tesseract workers are CPU-bound.
  return Math.max(1, Math.min(6, cores - 1));
}

function getPool(): Promise<Worker[]> {
  if (!poolPromise) {
    const size = wantedPoolSize();
    poolPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return Promise.all(Array.from({ length: size }, () => createWorker('eng')));
    })();
    poolPromise.catch(() => {
      poolPromise = null;
    });
  }
  return poolPromise;
}

/** Start the wasm + traineddata download early, so it overlaps page rendering. */
export function prewarmOcr(): void {
  if (typeof window === 'undefined') return;
  void getPool().catch(() => {});
}

export async function releaseOcrPool(): Promise<void> {
  const p = poolPromise;
  poolPromise = null;
  if (!p) return;
  await Promise.all((await p.catch(() => [])).map((w) => w.terminate().catch(() => {})));
}

export interface OcrOptions {
  /** Read every cell at several upscales and take the majority reading. */
  vote?: boolean;
  charsets?: (string | undefined)[];
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

const BASE_PARAMS = {
  tessedit_pageseg_mode: '6' as never,
  preserve_interword_spaces: '1',
};

export async function extractByOcr(
  page: RenderedPage,
  region: Region,
  grid: Grid,
  opts: OcrOptions = {},
): Promise<Table> {
  const { vote = true, onProgress, signal } = opts;
  const src = toCleanCanvas(grid, region);
  const pool = await getPool();

  const nRows = grid.rows.length;
  const nCols = grid.columns.length;
  const total = nRows * nCols;
  let done = 0;

  const out: Cell[][] = Array.from({ length: nRows }, () => new Array(nCols).fill(null) as Cell[]);

  // Ink boxes are pure typed-array work; measuring them once up front keeps the
  // worker lanes doing nothing but recognition.
  const boxes: (Box | null)[][] = grid.rows.map((r) =>
    grid.columns.map((c) => cellBox(grid, region.w, r, c)),
  );

  const blank = (): Cell => ({ text: '', unsure: true, confidence: 0 });

  /** Read one cell at every scale in `useScales` and reconcile the readings. */
  async function readCell(worker: Worker, cv: HTMLCanvasElement, box: Box, useScales: number[]): Promise<Cell> {
    const readings: string[] = [];
    let confSum = 0;
    for (const s of useScales) {
      const res = await worker.recognize(drawCell(cv, src, box, s));
      readings.push(clean(res.data.text));
      confSum += res.data.confidence;
    }
    const tally = new Map<string, number>();
    for (const v of readings) tally.set(v, (tally.get(v) ?? 0) + 1);
    const [best, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      text: best,
      // Disagreement between scales is the honest uncertainty signal here.
      unsure: n < readings.length,
      confidence: best ? confSum / readings.length : 0,
    };
  }

  /** Run `jobs` across the pool, one reusable canvas per lane. */
  async function runLanes(jobs: { ri: number; ci: number }[], scalesFor: (b: Box) => number[]) {
    let next = 0;
    await Promise.all(
      pool.map(async (worker) => {
        const cv = document.createElement('canvas');
        for (;;) {
          const i = next++;
          if (i >= jobs.length) return;
          if (signal?.aborted) return;
          const { ri, ci } = jobs[i];
          const box = boxes[ri][ci];
          out[ri][ci] = box ? await readCell(worker, cv, box, scalesFor(box)) : blank();
          done++;
          onProgress?.({ done, total, label: `Reading cells (${done}/${total})` });
        }
      }),
    );
  }

  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  // --- header row ---------------------------------------------------------
  // Headers are prose labels, never codes, so they are read with no whitelist.
  // Doing them as their own pass removes the two setParameters calls the old
  // code paid per header cell to flip the whitelist off and back on.
  await Promise.all(pool.map((w) => w.setParameters({ ...BASE_PARAMS, tessedit_char_whitelist: '' })));
  await runLanes(
    grid.columns.map((_, ci) => ({ ri: 0, ci })),
    (b) => [scaleFor(b, grid.textH)],
  );

  // --- data rows, column-major so a whitelist is set once per column --------
  for (let ci = 0; ci < nCols; ci++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const charset = opts.charsets?.[ci] ?? '';
    await Promise.all(
      pool.map((w) => w.setParameters({ ...BASE_PARAMS, tessedit_char_whitelist: charset })),
    );
    await runLanes(
      Array.from({ length: nRows - 1 }, (_, k) => ({ ri: k + 1, ci })),
      (b) => {
        const s = scaleFor(b, grid.textH);
        // Vote across neighbouring scales: a glyph that survives resampling at
        // three sizes is far more likely to be what was printed.
        return vote ? [...new Set([Math.max(1, s - 0.5), s, s + 1])] : [s];
      },
    );
  }

  const headers = out[0].map((c) => c.text);
  const rows = out.slice(1);
  flagOutliers(headers, rows);
  return { headers, rows, source: 'ocr' };
}

/**
 * Mark values that break their column's dominant shape. Values in a column
 * normally share a length and a digit/letter mask, so a reading that changes
 * either is worth a human glance before the numbers get used.
 */
export function flagOutliers(headers: string[], rows: Cell[][]) {
  const mask = (s: string) => s.replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'A');
  for (let ci = 0; ci < headers.length; ci++) {
    const vals = rows.map((r) => r[ci]?.text ?? '').filter(Boolean);
    if (vals.length < 4) continue;
    // Only meaningful for code-like columns; prose has no fixed shape.
    if (vals.some((v) => /\s/.test(v))) continue;

    const modeOf = <T,>(f: (v: string) => T): [T, number] => {
      const m = new Map<T, number>();
      for (const v of vals) m.set(f(v), (m.get(f(v)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    };
    const [modeLen, lenN] = modeOf((v) => v.length);
    const [modeMask, maskN] = modeOf(mask);

    // An empty cell is only suspicious when the column is otherwise always
    // filled — then it probably means the reader missed something. In a column
    // that is routinely blank it means the cell is blank, and flagging those
    // put a warning on most of the table for no reason at all.
    const emptyIsOdd = vals.length > rows.length * 0.85;

    for (const r of rows) {
      const cell = r[ci];
      if (!cell) continue;
      if (!cell.text) {
        if (emptyIsOdd) cell.unsure = true;
        continue;
      }
      // Flag low-confidence OCR readings
      if (cell.confidence >= 0 && cell.confidence < 60) cell.unsure = true;
      if (lenN > vals.length * 0.6 && cell.text.length !== modeLen) cell.unsure = true;
      else if (maskN > vals.length * 0.6 && mask(cell.text) !== modeMask) cell.unsure = true;
    }
  }
}

/**
 * Guess a per-column character set from a sample of readings, so a second pass
 * can constrain Tesseract. Codes read far better when 'S' cannot win over '5'.
 */
export function inferCharsets(headers: string[], rows: Cell[][]): string[] {
  return headers.map((_, ci) => {
    const vals = rows.slice(0, 30).map((r) => r[ci]?.text ?? '').filter(Boolean);
    if (vals.length < 3) return '';
    const joined = vals.join('');
    if (/\s/.test(joined)) return ''; // prose
    const digits = (joined.match(/[0-9]/g) ?? []).length;
    const alnum = (joined.match(/[A-Za-z0-9]/g) ?? []).length;
    if (digits / joined.length > 0.85) return CHARSETS.DIGIT;
    if (alnum / joined.length > 0.9 && !/[a-z]/.test(joined)) return CHARSETS.ALNUM;
    return '';
  });
}

/**
 * Snap near-duplicate values in a column that repeats heavily — a bank-name
 * column is a closed vocabulary, so a one-character slip can be voted away.
 * Columns of mostly-unique values are skipped: snapping those would silently
 * merge distinct records.
 */
export function snapLowCardinality(headers: string[], rows: Cell[][]) {
  const lev = (a: string, b: string) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  };

  for (let ci = 0; ci < headers.length; ci++) {
    const vals = rows.map((r) => r[ci]?.text ?? '').filter(Boolean);
    if (vals.length < 6) continue;
    const freq = new Map<string, number>();
    for (const v of vals) freq.set(v, (freq.get(v) ?? 0) + 1);
    if (freq.size > vals.length * 0.5) continue;

    const canon = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
    for (const r of rows) {
      const cell = r[ci];
      if (!cell?.text || (freq.get(cell.text) ?? 0) >= 3) continue;
      for (const c of canon) {
        if (c === cell.text || (freq.get(c) ?? 0) < 3) continue;
        if (lev(cell.text.toUpperCase(), c.toUpperCase()) <= Math.max(1, Math.round(c.length * 0.2))) {
          cell.text = c;
          cell.unsure = false;
          cell.confidence = Math.max(cell.confidence, 80);
          break;
        }
      }
    }
  }
}

export { analyse };
export type { Grid, Region, Column, Run };
