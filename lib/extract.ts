'use client';

import { analyse, median, mergedRuns, type Column, type Grid, type Region, type Run } from './grid';
import type { RenderedPage, TextItem } from './pdf';

export type Charset = 'AUTO' | 'ALNUM' | 'DIGIT' | 'TEXT';

export const CHARSETS: Record<Charset, string> = {
  AUTO: '',
  TEXT: '',
  ALNUM: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  DIGIT: '0123456789',
};

export interface Cell {
  text: string;
  /** true when the readings disagreed or the value breaks its column's shape */
  unsure: boolean;
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
  opts: { gutterFactor?: number; gutterRowTol?: number } = {},
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
  const columns: Column[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 1) columns.push({ x0: bounds[i], x1: bounds[i + 1] });
  }
  if (columns.length < 2) return null;

  const toRow = (line: TextItem[]) =>
    columns.map((c) => {
      const hits = line
        .filter((t) => (t.x0 + t.x1) / 2 >= c.x0 && (t.x0 + t.x1) / 2 < c.x1)
        .sort((a, b) => a.x0 - b.x0);
      return { text: clean(hits.map((t) => t.str).join(' ')), unsure: false };
    });

  return {
    headers: toRow(lines[0]).map((c) => c.text),
    rows: lines.slice(1).map(toRow),
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

const PAD = 6;

/**
 * Crop one cell, trimmed to its ink and upscaled. Tesseract is trained around
 * ~30px glyphs; screenshot text is a third of that, and the trim keeps the
 * upscale spending pixels on glyphs rather than on cell padding.
 */
function cellCanvas(
  src: HTMLCanvasElement,
  grid: Grid,
  regionW: number,
  r: Run,
  c: Column,
  scale: number,
): HTMLCanvasElement | null {
  let x0 = c.x1;
  let x1 = c.x0 - 1;
  let y0 = r.e;
  let y1 = r.s - 1;
  for (let y = r.s; y <= r.e; y++) {
    for (let x = c.x0; x < c.x1; x++) {
      if (grid.ink[y * regionW + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0) return null;

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const cv = document.createElement('canvas');
  cv.width = (w + PAD * 2) * scale;
  cv.height = (h + PAD * 2) * scale;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x0, y0, w, h, PAD * scale, PAD * scale, w * scale, h * scale);
  return cv;
}

type Worker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

async function makePool(size: number): Promise<Worker[]> {
  const { createWorker } = await import('tesseract.js');
  return Promise.all(Array.from({ length: size }, () => createWorker('eng')));
}

export interface OcrOptions {
  /** Read every cell at several upscales and take the majority reading. */
  vote?: boolean;
  charsets?: (string | undefined)[];
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

export async function extractByOcr(
  page: RenderedPage,
  region: Region,
  grid: Grid,
  opts: OcrOptions = {},
): Promise<Table> {
  const { vote = true, onProgress, signal } = opts;
  const scales = vote ? [3, 4, 5] : [4];
  const src = toCleanCanvas(grid, region);
  const poolSize = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
  const pool = await makePool(poolSize);

  const total = grid.rows.length * grid.columns.length;
  let done = 0;

  try {
    const out: Cell[][] = [];

    for (let ri = 0; ri < grid.rows.length; ri++) {
      out.push(new Array(grid.columns.length).fill(null) as unknown as Cell[]);
    }

    // Column-major so a whitelist is set once per column per worker rather than
    // per cell — setParameters is the expensive part of a Tesseract call.
    for (let ci = 0; ci < grid.columns.length; ci++) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const charset = opts.charsets?.[ci] ?? '';
      await Promise.all(
        pool.map((w) =>
          w.setParameters({
            tessedit_pageseg_mode: '7' as never,
            preserve_interword_spaces: '1',
            tessedit_char_whitelist: charset,
          }),
        ),
      );

      const jobs = grid.rows.map((r, ri) => ({ r, ri }));
      let next = 0;
      await Promise.all(
        pool.map(async (worker) => {
          for (;;) {
            const i = next++;
            if (i >= jobs.length) return;
            if (signal?.aborted) return;
            const { r, ri } = jobs[i];
            // The header is a label, never a code — read it unrestricted.
            const useScales = ri === 0 ? [4] : scales;
            const readings: string[] = [];
            for (const s of useScales) {
              const cv = cellCanvas(src, grid, region.w, r, grid.columns[ci], s);
              if (!cv) break;
              if (ri === 0 && charset) {
                await worker.setParameters({ tessedit_char_whitelist: '' });
              }
              const res = await worker.recognize(cv);
              readings.push(clean(res.data.text));
              if (ri === 0 && charset) {
                await worker.setParameters({ tessedit_char_whitelist: charset });
              }
            }
            let text = '';
            let unsure = false;
            if (readings.length) {
              const tally = new Map<string, number>();
              for (const v of readings) tally.set(v, (tally.get(v) ?? 0) + 1);
              const [best, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
              text = best;
              unsure = n < readings.length;
            }
            out[ri][ci] = { text, unsure };
            done++;
            onProgress?.({ done, total, label: `Reading cells (${done}/${total})` });
          }
        }),
      );
    }

    const headers = out[0].map((c) => c.text);
    const rows = out.slice(1);
    flagOutliers(headers, rows);
    return { headers, rows, source: 'ocr' };
  } finally {
    await Promise.all(pool.map((w) => w.terminate().catch(() => {})));
  }
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

    for (const r of rows) {
      const cell = r[ci];
      if (!cell) continue;
      if (!cell.text) {
        cell.unsure = true;
        continue;
      }
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
    const vals = rows.slice(0, 12).map((r) => r[ci]?.text ?? '').filter(Boolean);
    if (vals.length < 3) return '';
    const joined = vals.join('');
    if (/\s/.test(joined)) return ''; // prose
    const digits = (joined.match(/[0-9]/g) ?? []).length;
    const alnum = (joined.match(/[A-Za-z0-9]/g) ?? []).length;
    if (digits / joined.length > 0.95) return CHARSETS.DIGIT;
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
          break;
        }
      }
    }
  }
}

export { analyse };
export type { Grid, Region, Column, Run };
