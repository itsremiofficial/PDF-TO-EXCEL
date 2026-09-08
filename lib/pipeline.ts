'use client';

// The whole extraction, start to finish, with no user interaction:
//
//   upload -> enhance (deskew + text-safe upscale) -> AI OCR -> table
//
// The only click left is the download. Each stage reports progress and the
// intermediate page/region so the UI can show the page while the read runs.

import { analyse, guessTableRegion, type Grid, type Region } from './grid';
import {
  getTextItems,
  isImageFile,
  loadDocument,
  loadImageFile,
  renderPage,
  type RenderedPage,
  type TextItem,
} from './pdf';
import {
  extractByOcr,
  extractFromText,
  flagOutliers,
  inferCharsets,
  prewarmOcr,
  snapLowCardinality,
  type Table,
} from './extract';
import {
  cropRegion,
  cropRegionForVlm,
  extractTableWithGemini,
  prewarmUpscaler,
  upscaleWithLocalAi,
} from './ai';
import { enhanceForOcr, estimateSkew, type Enhanced } from './upscale';

const RENDER_WIDTH = 4400;

/** What actually produced the values, for the UI to be honest about. */
export type Engine = 'text' | 'gemini' | 'tesseract';

export type Stage = 'load' | 'detect' | 'enhance' | 'read' | 'done';

export interface PipelineOptions {
  signal?: AbortSignal;
  /** Called as each stage starts and progresses. */
  onStage?: (stage: Stage, label: string) => void;
  /** Called as soon as there is something to draw, before the read finishes. */
  onPage?: (view: PageView) => void;
  /** Re-read the image a second time and flag disagreements. Default true. */
  consensus?: boolean;
  gutterFactor?: number;
  /**
   * Pixels to hand the VLM, when they should differ from the page the local
   * engine works on. Defaults to the same page and region.
   */
  vlmSource?: { page: RenderedPage; region: Region };
}

export interface PageView {
  page: RenderedPage;
  region: Region;
  grid: Grid;
  textItems: TextItem[];
}

export interface PipelineResult extends PageView {
  table: Table;
  engine: Engine;
  /** Resample factor applied by the enhance stage; 1 means it was skipped. */
  factor: number;
  /** Degrees of skew corrected; 0 means the page was already level. */
  skew: number;
  /** Set when Gemini was unavailable and the local engine took over. */
  fallbackReason?: string;
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
};

/** Rasterise the file and pull its text layer, if it has one. */
async function load(
  file: File,
  onStage: PipelineOptions['onStage'],
): Promise<{ page: RenderedPage; textItems: TextItem[] }> {
  onStage?.('load', 'Rendering the page...');
  if (isImageFile(file)) {
    return { page: await loadImageFile(file, RENDER_WIDTH), textItems: [] };
  }
  const doc = await loadDocument(await file.arrayBuffer());
  const pg = await doc.getPage(1);
  const page = await renderPage(pg, RENDER_WIDTH);
  return { page, textItems: await getTextItems(pg, page.scale) };
}

/**
 * Read a table out of `file` with no further input.
 *
 * A PDF that carries its own text layer short-circuits everything below it:
 * those values are exact, and no amount of image work can improve on exact.
 * Everything else goes through enhancement and then the AI read, with the local
 * engine as the fallback when Gemini is unconfigured, rate-limited or down.
 */
export async function runPipeline(file: File, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const { signal, onStage } = opts;
  const gutterFactor = opts.gutterFactor ?? 1.2;

  const { page, textItems } = await load(file, onStage);
  throwIfAborted(signal);

  onStage?.('detect', 'Locating the table...');
  let region = guessTableRegion(page.gray, page.width, page.height);
  // Kept in original-page coordinates: enhancement rebases `region` onto its
  // own cropped output, and the VLM read needs the box in the source frame.
  const sourceRegion = region;
  let grid = analyse(page.gray, page.width, page.height, region, { gutterFactor });
  opts.onPage?.({ page, region, grid, textItems });

  // Photo-trained super-resolution can hallucinate strokes in small table
  // text. Keep it for ordinary documents, but dense reports are safer with the
  // deterministic text resampler below.
  if (textItems.length <= 20 && grid.columns.length < 10) prewarmUpscaler();

  // --- exact path ---------------------------------------------------------
  if (textItems.length > 20) {
    onStage?.('read', 'Reading the PDF text layer...');
    const t = extractFromText(textItems, region, { gutterFactor, grid });
    if (t) {
      flagOutliers(t.headers, t.rows);
      onStage?.('done', `Read ${t.rows.length} rows x ${t.headers.length} columns exactly from the text layer.`);
      return { page, region, grid, textItems, table: t, engine: 'text', factor: 1, skew: 0 };
    }
    onStage?.('read', 'Text layer did not form a table; falling back to the image.');
  }

  // --- enhance ------------------------------------------------------------
  onStage?.('enhance', 'Checking whether the table needs sharpening...');
  const enhanced =
    grid.columns.length >= 10
      ? enhanceForOcr(page, region, {
          textH: grid.textH,
          onProgress: (label) => opts.onStage?.('enhance', label),
        })
      : await enhanceRegion(page, region, grid.textH, opts);
  throwIfAborted(signal);

  let view: RenderedPage = page;
  if (enhanced.page !== page) {
    view = enhanced.page;
    region = { x: 0, y: 0, w: view.width, h: view.height };
    grid = analyse(view.gray, view.width, view.height, region, { gutterFactor });
    opts.onPage?.({ page: view, region, grid, textItems: [] });
  }

  // Warm the local engine now so that, if Gemini fails, the fallback does not
  // then have to download a wasm core and a language model from cold.
  prewarmOcr();

  // Gemini reads the *original* pixels, not the enhanced ones. Enhancement
  // exists for the geometric grid and for Tesseract, which both need big
  // glyphs; a VLM does not, and cropRegion would only scale the upscale back
  // down again — a second resample plus unsharp ringing plus JPEG, all of it
  // subtracting detail that was there in the first place.
  const read = await readRegion(view, region, grid, {
    ...opts,
    vlmSource: { page, region: padRegion(sourceRegion, page) },
  });
  return { ...read, page: view, region, grid, textItems: [], factor: enhanced.factor, skew: enhanced.skew };
}

/** Glyph height OCR wants; below this the region is worth upscaling. */
const TARGET_GLYPH_H = 32;

/** Real-ESRGAN x4 input budget. 4x of this is ~19MP, which the GPU can hold. */
const MODEL_INPUT_PIXELS = 1.2e6;

/**
 * Straighten and enlarge the table region for the local OCR engine and the
 * grid detector, both of which need glyphs near 32px to work well.
 *
 * Real-ESRGAN does the enlarging. It is a photo-trained GAN, so it can invent
 * stroke detail that was never on the page — see lib/upscale.ts for why that
 * matters on a column of serial numbers — but it is what this project asks for,
 * and the deterministic Lanczos path stays as the fallback when the model
 * cannot load or the GPU refuses the allocation.
 */
async function enhanceRegion(
  page: RenderedPage,
  region: Region,
  textH: number,
  opts: PipelineOptions,
): Promise<Enhanced> {
  const skew = estimateSkewOfRegion(page, region);
  // Already big enough and level: any pass here would only add artefacts.
  if (textH >= TARGET_GLYPH_H * 0.8 && !skew) return { page, factor: 1, skew: 0 };

  try {
    if (skew) opts.onStage?.('enhance', `Straightening the page (${skew.toFixed(1)} degrees off)...`);
    const src = regionCanvas(page, region, skew);
    const blob = await cropRegion(
      { canvas: src },
      { x: 0, y: 0, w: src.width, h: src.height },
      { maxPixels: MODEL_INPUT_PIXELS },
    );
    throwIfAborted(opts.signal);

    opts.onStage?.('enhance', 'Upscaling the table 4x with Real-ESRGAN (in this browser)...');
    const up = await upscaleWithLocalAi(blob, {
      signal: opts.signal,
      onProgress: (label) => opts.onStage?.('enhance', label),
    });
    const rendered = await loadImageFile(up, Number.MAX_SAFE_INTEGER);
    return { page: rendered, factor: rendered.width / region.w, skew };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // Model download blocked, WebGL unavailable, texture allocation refused:
    // none of those should sink the extraction when a CPU path exists.
    opts.onStage?.('enhance', 'AI upscaler unavailable - sharpening on the CPU instead...');
    return enhanceForOcr(page, region, {
      textH,
      onProgress: (label) => opts.onStage?.('enhance', label),
    });
  }
}

/** Region cropped out of the page canvas in colour, rotated level if needed. */
function regionCanvas(page: RenderedPage, region: Region, skew: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = region.w;
  cv.height = region.h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (skew) {
    ctx.translate(region.w / 2, region.h / 2);
    ctx.rotate((skew * Math.PI) / 180);
    ctx.translate(-region.w / 2, -region.h / 2);
  }
  ctx.drawImage(page.canvas, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  return cv;
}

function estimateSkewOfRegion(page: RenderedPage, region: Region): number {
  const g = new Uint8Array(region.w * region.h);
  for (let y = 0; y < region.h; y++) {
    const src = (region.y + y) * page.width + region.x;
    g.set(page.gray.subarray(src, src + region.w), y * region.w);
  }
  return estimateSkew(g, region.w, region.h);
}

/**
 * Widen a guessed region by a small margin of the page.
 *
 * The automatic flow never gets a human to check the box before the read, so
 * the cost of the two mistakes is lopsided: a slightly loose crop gives the
 * model some harmless surrounding page, while a crop three pixels too tight
 * silently truncates a column of serial numbers and nothing downstream can
 * tell. Pad towards the forgiving one.
 */
function padRegion(r: Region, page: RenderedPage): Region {
  const mx = Math.round(page.width * 0.025);
  const my = Math.round(page.height * 0.025);
  const x = Math.max(0, r.x - mx);
  const y = Math.max(0, r.y - my);
  return {
    x,
    y,
    w: Math.min(page.width - x, r.w + mx * 2),
    h: Math.min(page.height - y, r.h + my * 2),
  };
}

export interface ReadResult {
  table: Table;
  engine: Engine;
  fallbackReason?: string;
}

/**
 * Read the table inside an already-prepared region: Gemini first, the local
 * engine when Gemini is unconfigured, rate-limited or down. Exposed separately
 * so re-reading a hand-adjusted box does not redo load and enhancement.
 */
export async function readRegion(
  view: RenderedPage,
  region: Region,
  grid: Grid,
  opts: PipelineOptions = {},
): Promise<ReadResult> {
  const { signal, onStage } = opts;
  let fallbackReason: string;

  try {
    onStage?.('read', 'Reading the table with Gemini...');
    const vlm = opts.vlmSource ?? { page: view, region };
    // Native resolution, lossless where it fits. See cropRegionForVlm for why
    // shrinking or JPEG-ing this image is what breaks character-level reads.
    const blob = await cropRegionForVlm(vlm.page, vlm.region);
    throwIfAborted(signal);
    const t = await extractTableWithGemini(blob, {
      signal,
      consensus: opts.consensus ?? true,
      hint: { rows: grid.rows.length, columns: grid.columns.length },
      onProgress: (label) => onStage?.('read', label),
    });
    flagOutliers(t.headers, t.rows);
    onStage?.('done', summarise(t, 'gemini'));
    return { table: t, engine: 'gemini' };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    fallbackReason = (err as Error).message;
  }

  if (!grid.rows.length || grid.columns.length < 2) {
    throw new Error(
      `${fallbackReason} And the local reader found no table grid to fall back on ` +
        `(${grid.rows.length} row(s), ${grid.columns.length} column(s)) - drag a box around the table and re-read.`,
    );
  }

  onStage?.('read', 'Gemini unavailable - reading locally with Tesseract...');
  // A short unrestricted probe first, so the full pass can constrain each
  // column's character set; codes read far better when 'S' cannot win over '5'.
  const probe = await extractByOcr(
    view,
    region,
    { ...grid, rows: grid.rows.slice(0, Math.min(grid.rows.length, 9)) },
    { vote: false, signal, onProgress: (p) => onStage?.('read', p.label) },
  );
  throwIfAborted(signal);

  const t = await extractByOcr(view, region, grid, {
    vote: true,
    charsets: inferCharsets(probe.headers, probe.rows),
    signal,
    onProgress: (p) => onStage?.('read', p.label),
  });
  snapLowCardinality(t.headers, t.rows);
  flagOutliers(t.headers, t.rows);
  onStage?.('done', summarise(t, 'tesseract'));
  return { table: t, engine: 'tesseract', fallbackReason };
}

function summarise(t: Table, engine: Engine): string {
  const flagged = t.rows.filter((r) => r.some((c) => c?.unsure)).length;
  const who = engine === 'gemini' ? 'Gemini' : 'The local reader';
  return (
    `${who} read ${t.rows.length} rows x ${t.headers.length} columns. ` +
    (flagged
      ? `${flagged} row(s) contain a cell worth checking - they are highlighted.`
      : 'Every value passed the consistency checks.')
  );
}
