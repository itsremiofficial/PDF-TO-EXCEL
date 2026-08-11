'use client';

// Text-safe image enhancement for OCR.
//
// Why not a GAN upscaler here: ESRGAN-family models are trained on natural
// photographs and are documented to hallucinate glyphs on degradations they
// were not trained for — they reduce noise but do not restore text structure.
// For a table of serial numbers that failure mode is the worst one available:
// the output looks sharper and is confidently wrong, and nothing downstream can
// tell. Deskew + Lanczos-3 + unsharp only ever redistributes light that was
// actually measured, so a blurry glyph stays blurry instead of becoming a
// different, crisp glyph. It is also ~50x faster and needs no model download.
//
// The GAN path still exists in ./ai (upscaleWithLocalAi) for callers that want
// it; it is deliberately not on the automatic pipeline.

// Extension-qualified so `node --test` can strip types and resolve this at
// runtime; the bundler is happy either way.
import { otsu } from './grid.ts';
import type { Region } from './grid.ts';
import type { RenderedPage } from './pdf';

// ---------------------------------------------------------------------------
// Lanczos-3 resampling (separable, single channel)
// ---------------------------------------------------------------------------

function lanczos(x: number, a: number): number {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

interface Kernel {
  start: Int32Array;
  count: Int32Array;
  w: Float32Array;
  taps: number;
}

/** Precompute one weight row per output pixel; both passes reuse it per line. */
function buildKernel(srcLen: number, dstLen: number, a = 3): Kernel {
  const ratio = dstLen / srcLen;
  // Downscaling has to widen the kernel to stay an anti-aliasing filter.
  const filterScale = ratio < 1 ? 1 / ratio : 1;
  const support = a * filterScale;
  const taps = Math.ceil(support * 2) + 2;
  const start = new Int32Array(dstLen);
  const count = new Int32Array(dstLen);
  const w = new Float32Array(dstLen * taps);

  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) / ratio - 0.5;
    const s = Math.max(0, Math.ceil(center - support));
    const e = Math.min(srcLen - 1, Math.floor(center + support));
    start[i] = s;
    count[i] = e - s + 1;
    let sum = 0;
    for (let j = s; j <= e; j++) {
      const v = lanczos((j - center) / filterScale, a);
      w[i * taps + (j - s)] = v;
      sum += v;
    }
    if (sum) for (let k = 0; k < count[i]; k++) w[i * taps + k] /= sum;
  }
  return { start, count, w, taps };
}

export function resampleGray(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const kx = buildKernel(sw, dw);
  const tmp = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    const so = y * sw;
    const to = y * dw;
    for (let x = 0; x < dw; x++) {
      const s = kx.start[x];
      const n = kx.count[x];
      const wo = x * kx.taps;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += src[so + s + k] * kx.w[wo + k];
      tmp[to + x] = acc;
    }
  }

  const ky = buildKernel(sh, dh);
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const s = ky.start[y];
    const n = ky.count[y];
    const wo = y * ky.taps;
    const to = y * dw;
    for (let x = 0; x < dw; x++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += tmp[(s + k) * dw + x] * ky.w[wo + k];
      out[to + x] = acc < 0 ? 0 : acc > 255 ? 255 : acc;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unsharp mask
// ---------------------------------------------------------------------------

/** Separable 1-2-1 blur, applied `passes` times to approximate a Gaussian. */
function blur(src: Uint8Array, w: number, h: number, passes: number): Float32Array {
  let cur = Float32Array.from(src);
  let next = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const l = cur[o + (x > 0 ? x - 1 : 0)];
        const r = cur[o + (x < w - 1 ? x + 1 : w - 1)];
        next[o + x] = (l + 2 * cur[o + x] + r) * 0.25;
      }
    }
    [cur, next] = [next, cur];
    for (let y = 0; y < h; y++) {
      const o = y * w;
      const up = (y > 0 ? y - 1 : 0) * w;
      const dn = (y < h - 1 ? y + 1 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        next[o + x] = (cur[up + x] + 2 * cur[o + x] + cur[dn + x]) * 0.25;
      }
    }
    [cur, next] = [next, cur];
  }
  return cur;
}

/**
 * Sharpen edges that resampling softened. `amount` is deliberately modest:
 * overshoot turns anti-aliased stroke edges into ringing, which binarisation
 * then reads as extra ink and OCR reads as punctuation.
 */
export function unsharp(gray: Uint8Array, w: number, h: number, amount = 0.9, passes = 1): Uint8Array {
  const lo = blur(gray, w, h, passes);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const v = gray[i] + amount * (gray[i] - lo[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deskew
// ---------------------------------------------------------------------------

/** Nearest-power box downsample, enough for a skew estimate. */
function shrink(src: Uint8Array, w: number, h: number, tw: number): { g: Uint8Array; w: number; h: number } {
  if (w <= tw) return { g: src, w, h };
  const f = Math.ceil(w / tw);
  const nw = Math.floor(w / f);
  const nh = Math.floor(h / f);
  const g = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) {
        const o = (y * f + dy) * w + x * f;
        for (let dx = 0; dx < f; dx++) sum += src[o + dx];
      }
      g[y * nw + x] = (sum / (f * f)) | 0;
    }
  }
  return { g, w: nw, h: nh };
}

/**
 * Estimate page skew by projection-profile sharpness.
 *
 * When rows of text are level, the horizontal ink projection is a comb: near
 * zero between lines, high inside them. Tilt it and the comb smears. Scoring
 * candidate angles by the squared gradient of that profile finds the angle
 * where the comb is sharpest, which is level. Small angles only — a table that
 * is 10 degrees off is a different problem, and searching that far invites
 * false maxima from the table's own rules.
 */
export function estimateSkew(gray: Uint8Array, w: number, h: number, maxDeg = 4, step = 0.25): number {
  const { g, w: sw, h: sh } = shrink(gray, w, h, 800);
  if (sh < 40) return 0;

  // otsu() returns the level that closes the dark class, so the dark class is
  // `<= thr`. Testing `< thr` drops the boundary level entirely, which on a
  // clean two-tone scan is every ink pixel there is.
  const thr = otsu(g);
  const ink = new Uint8Array(sw * sh);
  let inkCount = 0;
  for (let i = 0; i < ink.length; i++) {
    if (g[i] <= thr) {
      ink[i] = 1;
      inkCount++;
    }
  }
  // Too little ink to measure, or so much that this is not a page of text.
  if (inkCount < sw * 2 || inkCount > ink.length * 0.6) return 0;

  const proj = new Float64Array(sh);
  const scoreAt = (deg: number): number => {
    const t = Math.tan((deg * Math.PI) / 180);
    proj.fill(0);
    for (let y = 0; y < sh; y++) {
      const o = y * sw;
      for (let x = 0; x < sw; x++) {
        if (!ink[o + x]) continue;
        // Shear instead of rotate: for angles this small the difference is
        // sub-pixel, and a shear costs one add per ink pixel.
        const yy = Math.round(y + (x - sw / 2) * t);
        if (yy >= 0 && yy < sh) proj[yy]++;
      }
    }
    let score = 0;
    for (let y = 1; y < sh; y++) {
      const d = proj[y] - proj[y - 1];
      score += d * d;
    }
    return score;
  };

  // Score level first and make it the incumbent, so a flat or ambiguous
  // response leaves the page alone. Seeding with the first candidate instead
  // would answer -maxDeg — the worst possible answer — whenever nothing wins.
  let bestAngle = 0;
  let bestScore = scoreAt(0);
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += step) {
    if (Math.abs(deg) < 1e-9) continue;
    const score = scoreAt(deg);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = deg;
    }
  }
  // Sub-degree noise is not worth a resample pass of its own.
  return Math.abs(bestAngle) < 0.3 ? 0 : bestAngle;
}

/** Rotate a grayscale buffer about its centre, bilinear, white outside. */
export function rotateGray(src: Uint8Array, w: number, h: number, deg: number): Uint8Array {
  const rad = (-deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  const out = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const sx = cx + dx * cos - dy * sin;
      const sy = cy + dx * sin + dy * cos;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const o = y0 * w + x0;
      const v =
        src[o] * (1 - fx) * (1 - fy) +
        src[o + 1] * fx * (1 - fy) +
        src[o + w] * (1 - fx) * fy +
        src[o + w + 1] * fx * fy;
      out[y * w + x] = v | 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pipeline entry
// ---------------------------------------------------------------------------

/** Glyph height Tesseract is trained around; also comfortable for a VLM read. */
export const TARGET_GLYPH_H = 32;

/** Upper bound on the enhanced buffer, to keep allocation and OCR time sane. */
const MAX_PIXELS = 36e6;

export interface EnhanceOptions {
  /** Median text-row height inside the region, in page pixels. */
  textH: number;
  targetGlyphH?: number;
  deskew?: boolean;
  onProgress?: (label: string) => void;
}

export interface Enhanced {
  page: RenderedPage;
  /** Resample factor actually applied (1 = untouched). */
  factor: number;
  /** Degrees of skew corrected (0 = none). */
  skew: number;
}

function grayToCanvas(gray: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.createImageData(w, h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = gray[p];
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Deskew, upscale and sharpen `region` of `page` into a standalone page sized
 * so its glyphs land near the OCR sweet spot. Returns the input untouched when
 * the text is already big enough and level — the common case for a 300dpi scan,
 * where doing the work would cost seconds and buy nothing.
 */
export function enhanceForOcr(page: RenderedPage, region: Region, opts: EnhanceOptions): Enhanced {
  const target = opts.targetGlyphH ?? TARGET_GLYPH_H;
  const { x, y, w, h } = region;

  // Crop the region out of the page's grayscale buffer.
  let gray = new Uint8Array(w * h);
  for (let ry = 0; ry < h; ry++) {
    const src = (y + ry) * page.width + x;
    gray.set(page.gray.subarray(src, src + w), ry * w);
  }

  const skew = opts.deskew === false ? 0 : estimateSkew(gray, w, h);
  if (skew) {
    opts.onProgress?.(`Straightening the page (${skew.toFixed(1)} degrees off)...`);
    gray = rotateGray(gray, w, h, skew);
  }

  let factor = opts.textH > 0 ? target / opts.textH : 1;
  factor = Math.max(1, Math.min(4, factor));
  const budget = Math.sqrt(MAX_PIXELS / Math.max(1, w * h));
  factor = Math.min(factor, budget);

  let out = gray;
  let ow = w;
  let oh = h;
  if (factor > 1.05) {
    opts.onProgress?.(`Sharpening the table (${factor.toFixed(1)}x, text-safe)...`);
    ow = Math.round(w * factor);
    oh = Math.round(h * factor);
    out = resampleGray(gray, w, h, ow, oh);
    // Gentle on purpose. This buffer gets binarised downstream, and unsharp
    // overshoot puts a bright halo either side of every stroke; threshold that
    // and the halo becomes ink, which OCR reads as stray punctuation.
    out = unsharp(out, ow, oh, 0.6, 1);
  } else if (skew) {
    factor = 1;
  } else {
    // Nothing to do: hand back a view of the original page.
    return { page, factor: 1, skew: 0 };
  }

  return {
    page: { canvas: grayToCanvas(out, ow, oh), gray: out, width: ow, height: oh, scale: page.scale * factor },
    factor,
    skew,
  };
}
