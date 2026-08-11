// Free-AI integration: Google Gemini (image -> table) plus a local, in-browser
// Real-ESRGAN upscaler (WebGL/WASM via TensorFlow.js - free, no upload).
// The upscaler runs entirely in the browser. The Gemini read goes through
// /api/gemini so the API key stays on the server (GEMINI_API_KEY in .env.local,
// see .env.example). Only the selected table area is sent, never the whole file
// unless the user chose a full-page region.

import type { Region } from './grid';
import type { Cell, Table } from './extract';

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

export interface CropOptions {
  /** Cap the long side at this many pixels. */
  maxDim?: number;
  /** Explicit scale factor, clamped to 1 (we never invent pixels here). */
  scale?: number;
  /** Cap total area; the binding constraint for wide-but-short table strips. */
  maxPixels?: number;
}

/**
 * Crop `region` out of a rendered page, downscaled by whichever of `scale`,
 * `maxDim` and `maxPixels` bites hardest, encoded as JPEG. Keep the region
 * modest: free tiers refuse giant payloads and neither Gemini nor the upscaler
 * gains from oversized input.
 */
export function cropRegion(
  page: { canvas: HTMLCanvasElement },
  region: Region,
  opts: CropOptions = {},
): Promise<Blob> {
  const { x, y, w, h } = region;
  let scale = Math.min(1, opts.scale ?? 1);
  if (opts.maxDim) scale = Math.min(scale, opts.maxDim / Math.max(w, h, 1));
  if (opts.maxPixels) scale = Math.min(scale, Math.sqrt(opts.maxPixels / Math.max(1, w * h)));
  return encode(drawCrop(page, region, scale), 'image/jpeg', 0.92);
}

function drawCrop(
  page: { canvas: HTMLCanvasElement },
  region: Region,
  scale: number,
): HTMLCanvasElement {
  const { x, y, w, h } = region;
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(page.canvas, x, y, w, h, 0, 0, cw, ch);
  return cv;
}

function encode(cv: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    cv.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the region as an image'))),
      type,
      quality,
    ),
  );
}

/**
 * Encode a region for the VLM at the best fidelity that still fits the request.
 *
 * Two things ruin a table read and both look harmless. Downscaling to a "safe"
 * size shrinks 12px glyphs to 8px, below what any reader can call reliably.
 * And JPEG puts ringing either side of every thin stroke, which is precisely
 * the difference between 8 and B, or 5 and S. So: keep native resolution, try
 * lossless PNG first — a table is flat colour and compresses well — and only
 * give ground when the payload genuinely will not fit, resolution last.
 *
 * `maxBytes` guards the host's request-body limit (Vercel's is 4.5MB) with room
 * for the ~33% base64 inflation on top.
 */
export async function cropRegionForVlm(
  page: { canvas: HTMLCanvasElement },
  region: Region,
  opts: { maxPixels?: number; maxBytes?: number } = {},
): Promise<Blob> {
  const maxPixels = opts.maxPixels ?? 16e6;
  const maxBytes = opts.maxBytes ?? 2.8e6;
  const base = Math.min(1, Math.sqrt(maxPixels / Math.max(1, region.w * region.h)));

  let scale = base;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cv = drawCrop(page, region, scale);
    // Lossless first; on a screenshot or a clean scan this usually wins on both
    // size and quality, because flat backgrounds cost PNG almost nothing.
    const png = await encode(cv, 'image/png');
    if (png.size <= maxBytes) return png;

    const jpeg = await encode(cv, 'image/jpeg', 0.95);
    if (jpeg.size <= maxBytes) return jpeg;

    // Both too big: shrink towards the budget and try again. Resolution is the
    // last thing to go because it is the one loss OCR cannot work around.
    const next = scale * Math.sqrt(maxBytes / jpeg.size) * 0.95;
    if (next >= scale) return jpeg;
    scale = next;
  }
  return encode(drawCrop(page, region, scale), 'image/jpeg', 0.9);
}

// ---------------------------------------------------------------------------
// AI image -> text (Google Gemini, free tier)
// ---------------------------------------------------------------------------

const BASE_PROMPT = `You are a precise table OCR engine. Read the table in the attached image exactly as it is printed.

Rules:
- The first row of the table is the header row.
- Preserve every value exactly: codes, serial numbers, punctuation and letter case. Never reformat, correct, translate, complete or guess a value.
- Read every data row, top to bottom, including rows that repeat an earlier value. Do not deduplicate, summarise or skip.
- Every row must have exactly as many entries as "headers". An empty cell becomes "".
- Ambiguous characters matter: distinguish 0/O, 1/I/l, 5/S, 8/B, 2/Z by the glyph shape actually drawn, not by what the value "should" be.
- Do not invent rows, columns or values, and do not add commentary.

Return a single JSON object with exactly two keys:
{"headers": ["..."], "rows": [["...", "..."], ...]}
where "headers" is an array of strings and "rows" is an array of arrays of strings.`;

/** Geometry we already measured; telling the model steadies row/column counts. */
export interface GridHint {
  rows?: number;
  columns?: number;
}

function promptFor(hint?: GridHint): string {
  if (!hint?.rows && !hint?.columns) return BASE_PROMPT;
  const bits: string[] = [];
  if (hint.columns) bits.push(`about ${hint.columns} columns`);
  if (hint.rows) bits.push(`about ${hint.rows} rows including the header`);
  return `${BASE_PROMPT}

Layout analysis of this same image found ${bits.join(' and ')}. Treat that as a
sanity check, not as truth: trust what you can see, but if your reading differs
a lot, look again for a row or column you merged or split.`;
}

export interface AiOptions {
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
  hint?: GridHint;
  /**
   * Read the image twice and mark every cell the two reads disagree on. At
   * temperature 0 the reads are normally identical, so a disagreement is a real
   * signal that the glyphs were ambiguous — the cells most worth a human eye.
   * Costs a second request.
   */
  consensus?: boolean;
}

interface RawTable {
  headers: string[];
  rows: string[][];
}

async function geminiRead(blob: Blob, opts: AiOptions): Promise<RawTable> {
  const b64 = await blobToBase64(blob);
  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: blob.type || 'image/jpeg', data: b64 } },
          { text: promptFor(opts.hint) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 1,
      responseMimeType: 'application/json',
      // A wide table of 60 rows can run long; the default cap truncates it into
      // malformed JSON, which reads to the user as "the AI failed".
      maxOutputTokens: 65536,
    },
  });

  const res = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: opts.signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const raw = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(
      res.status === 429
        ? 'Gemini free-tier rate limit hit (429) - wait a moment and try again.'
        : `Gemini rejected the request (${res.status}): ${raw}`,
    );
  }

  const parts = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0]?.content?.parts;
  const text = parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new Error('Gemini returned an empty response.');
  return parseTableJson(text);
}

/**
 * Ask Gemini to read the table in `blob` and return it as a Table, via the
 * /api/gemini proxy that holds the key. Throws with a human-readable message
 * on key, quota or parsing failures.
 */
export async function extractTableWithGemini(blob: Blob, opts: AiOptions = {}): Promise<Table> {
  opts.onProgress?.('Reading the table with Gemini...');
  const first = await geminiRead(blob, opts);
  if (first.rows.length === 0) throw new Error('Gemini did not find any table rows in that region.');

  let second: RawTable | null = null;
  if (opts.consensus) {
    opts.onProgress?.('Second read, cross-checking every cell...');
    // A failed confirmation pass must not throw away a good first read.
    second = await geminiRead(blob, opts).catch(() => null);
  }

  return mergeReads(first, second);
}

/**
 * Combine one or two reads of the same image into a Table, flagging exactly
 * the cells the reads disagree on.
 *
 * The flag has to stay rare to stay useful. An earlier version marked every
 * cell in the table whenever the two reads returned different row counts,
 * which on a long table is often — the result was a wall of red on output that
 * was almost entirely correct, which trains people to ignore the highlight.
 * Only real per-cell disagreements, and rows one read did not produce at all,
 * are worth a human's attention.
 */
export function mergeReads(first: RawTable, second: RawTable | null): Table {
  // A dropped row is the common VLM slip; an invented one is rare. So when the
  // two reads disagree on length, the longer one is the better base.
  const base = second && second.rows.length > first.rows.length ? second : first;
  const other = base === first ? second : first;

  const headers = base.headers.map((h) => h.trim());
  const pairs = other ? alignRows(base.rows, other.rows) : base.rows.map(() => null);

  const rows = base.rows.map((r, ri) => {
    const cmp = pairs[ri];
    return Array.from({ length: headers.length }, (_, ci): Cell => {
      const text = r[ci] ?? '';
      if (!other) return { text, unsure: false, confidence: 100 };
      // A row the other read never produced at all: real uncertainty.
      if (!cmp) return { text, unsure: true, confidence: 50 };
      const same = (cmp[ci] ?? '') === text;
      return { text, unsure: !same, confidence: same ? 100 : 40 };
    });
  });

  return { headers, rows, source: 'ocr' };
}

const rowKey = (r: string[]) => r.join('');

/**
 * Pair each row of `a` with the row of `b` that means the same thing.
 *
 * Comparing by raw index looks right and is badly wrong: if one read emits a
 * single row the other skipped, every subsequent index is shifted and every
 * later row compares unequal. Two correct reads then disagree everywhere, and
 * the whole table gets flagged — which is precisely the useless "every row is
 * low confidence" output this replaced.
 *
 * So: find the rows both reads produced identically (a longest common
 * subsequence over row contents) and use those as anchors. Between anchors,
 * pair the leftovers off in order — those are the rows that differ in some
 * cell but still correspond, which is exactly the comparison worth making.
 */
export function alignRows(a: string[][], b: string[][]): (string[] | null)[] {
  const n = a.length;
  const m = b.length;
  const ka = a.map(rowKey);
  const kb = b.map(rowKey);

  // Standard LCS table over row keys.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: (string[] | null)[] = new Array(n).fill(null);
  // Rows since the last anchor, on each side, waiting to be paired positionally.
  let gapA: number[] = [];
  let gapB: number[] = [];
  const drainGap = () => {
    for (let k = 0; k < Math.min(gapA.length, gapB.length); k++) out[gapA[k]] = b[gapB[k]];
    gapA = [];
    gapB = [];
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      drainGap();
      out[i] = b[j];
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      gapA.push(i++);
    } else {
      gapB.push(j++);
    }
  }
  while (i < n) gapA.push(i++);
  while (j < m) gapB.push(j++);
  drainGap();
  return out;
}

/** Gemini's JSON mode returns bare JSON; be tolerant of fences anyway. */
export function parseTableJson(text: string): { headers: string[]; rows: string[][] } {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Gemini did not return JSON - try again or use OCR instead.');
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error('Gemini returned malformed JSON - try again or use OCR instead.');
  }
  const o = obj as { headers?: unknown; rows?: unknown };
  const headers = Array.isArray(o.headers) ? o.headers.map(String) : [];
  const rows = Array.isArray(o.rows)
    ? o.rows.map((r) => (Array.isArray(r) ? r.map((v) => (v == null ? '' : String(v))) : []))
    : [];
  if (!headers.length || !rows.length) throw new Error('Gemini returned an empty table.');
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// AI upscaling (in-browser Real-ESRGAN x4 via TensorFlow.js)
// ---------------------------------------------------------------------------

// Patch size for the upscaler. A whole 1024px region run in one pass allocates
// 4096x4096 float textures per conv layer, which blows past the WebGL texture
// limit ("glTexStorage2D: Texture total allocation size is too large") and
// trips TF.js's "high memory usage in GPU" leak warning. Tiling keeps every
// intermediate texture small; `padding` overlaps the tiles so the seams don't
// show. 128 is the size esrgan-slim was trained at (its model meta reports
// patchSize 128), so it is both the best-quality and the fastest safe choice:
// a 1024px region becomes 64 patches of 512px output instead of 256 tiny ones.
const PATCH_SIZE = 128;
const PATCH_PADDING = 4;

type UpscalerLike = {
  upscale(
    image: HTMLImageElement,
    options: {
      output: 'base64';
      patchSize?: number;
      padding?: number;
      signal?: AbortSignal;
      awaitNextFrame?: boolean;
      progress?: (amount: number) => void;
    },
  ): Promise<string>;
  dispose(): Promise<void>;
};

let upscalerPromise: Promise<UpscalerLike> | null = null;

/** Lazy singleton: the ~5MB TF.js runtime + model load only on first use. */
async function getUpscaler(): Promise<UpscalerLike> {
  if (!upscalerPromise) {
    upscalerPromise = (async () => {
      const [{ default: Upscaler }, modelPkg] = await Promise.all([
        import('upscaler') as Promise<{ default: new (opts: { model: unknown }) => UpscalerLike }>,
        import('@upscalerjs/esrgan-slim'),
      ]);
      return new Upscaler({ model: modelPkg.x4 });
    })();
    // Don't cache a rejection: one flaky model download would otherwise break
    // upscaling for the rest of the page's life, replaying the same error.
    upscalerPromise.catch(() => {
      upscalerPromise = null;
    });
  }
  return upscalerPromise;
}

/**
 * Kick off the model download without waiting for it. Called as soon as a file
 * is picked so the ~5MB TF.js runtime and the weights come down while the page
 * is still rasterising, instead of adding their latency to the upscale step.
 */
export function prewarmUpscaler(): void {
  if (typeof window === 'undefined') return;
  void getUpscaler().catch(() => {});
}


function loadHtmlImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the region image.'));
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    img.src = src;
  });
}

/**
 * Upscale `blob` 4x with Real-ESRGAN, running entirely in this browser
 * (WebGL/WASM). Free, private, no API key and nothing is uploaded; the model
 * weights are fetched from a CDN on first use.
 */
export async function upscaleWithLocalAi(blob: Blob, opts: AiOptions = {}): Promise<Blob> {
  if (typeof window === 'undefined') throw new Error('AI upscaling only runs in the browser.');
  if (!blob.size) throw new Error('Nothing to upscale.');

  const url = URL.createObjectURL(blob);
  try {
    opts.onProgress?.('Loading the AI upscaler (first run downloads the model)...');
    const upscaler = await getUpscaler();
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const img = await loadHtmlImage(url, opts.signal);
    opts.onProgress?.('Upscaling with Real-ESRGAN...');
    const dataUrl = await upscaler.upscale(img, {
      output: 'base64',
      patchSize: PATCH_SIZE,
      padding: PATCH_PADDING,
      signal: opts.signal,
      // yield to the browser between patches so the tab stays responsive and
      // WebGL can recycle textures instead of piling them up
      awaitNextFrame: true,
      progress: (amount) => opts.onProgress?.(`Upscaling with Real-ESRGAN... ${Math.round(amount * 100)}%`),
    });
    const res = await fetch(dataUrl);
    const out = await res.blob();
    if (!out.size) throw new Error('AI upscaler produced an empty image.');
    return out;
  } catch (err) {
    // UpscalerJS throws its own AbortError whose `name` is still "Error", so
    // callers filtering on name === 'AbortError' would show a cancel as a
    // failure. Normalise it to a real AbortError.
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read the image.'));
    fr.onload = () => resolve((fr.result as string).split(',')[1] ?? '');
    fr.readAsDataURL(blob);
  });
}
