// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSkew, resampleGray, rotateGray, unsharp } from './upscale.ts';

/** White page with dark horizontal text-like bars, optionally sheared. */
function page(w: number, h: number, slope = 0): Uint8Array {
  const g = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const yy = y + Math.round(slope * (x - w / 2));
      // A bar every 20 rows, 6 rows tall, with gaps so it reads as glyphs.
      if (yy >= 0 && yy % 20 < 6 && x % 7 < 5) g[y * w + x] = 20;
    }
  }
  return g;
}

test('resampleGray preserves a flat field exactly', () => {
  const src = new Uint8Array(40 * 40).fill(130);
  const out = resampleGray(src, 40, 40, 80, 80);
  assert.equal(out.length, 80 * 80);
  for (const v of out) assert.ok(Math.abs(v - 130) <= 1, `got ${v}`);
});

test('resampleGray keeps an edge in place when upscaling 2x', () => {
  const w = 32;
  const src = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) src[y * w + x] = x < 16 ? 0 : 255;
  const out = resampleGray(src, w, w, w * 2, w * 2);

  const row = 32 * (w * 2);
  // Far from the edge the two plateaus must survive untouched.
  assert.ok(out[row + 4] < 10);
  assert.ok(out[row + 59] > 245);
  // The transition must sit at the doubled edge position, not drift.
  let cross = -1;
  for (let x = 0; x < w * 2 - 1; x++) {
    if (out[row + x] < 128 && out[row + x + 1] >= 128) cross = x;
  }
  assert.ok(Math.abs(cross - 31) <= 1, `edge landed at ${cross}`);
});

test('unsharp steepens an edge without inventing ink on flat areas', () => {
  const w = 32;
  const src = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) src[y * w + x] = x < 16 ? 60 : 200;
  const out = unsharp(src, w, w, 0.9, 1);
  const row = 16 * w;
  assert.ok(out[row + 15] <= src[row + 15], 'dark side of the edge should darken');
  assert.ok(out[row + 16] >= src[row + 16], 'light side of the edge should lighten');
  // Ten pixels from the edge the blur and the source agree, so nothing moves.
  assert.equal(out[row + 2], 60);
  assert.equal(out[row + 29], 200);
});

test('estimateSkew reports zero for a level page', () => {
  assert.equal(estimateSkew(page(600, 400), 600, 400), 0);
});

test('estimateSkew finds a tilt, and rotateGray with that answer levels it', () => {
  const w = 600;
  const h = 400;
  const tilt = Math.tan((2 * Math.PI) / 180);
  const skewed = page(w, h, tilt);

  const est = estimateSkew(skewed, w, h);
  assert.ok(Math.abs(Math.abs(est) - 2) <= 0.5, `expected ~2 degrees, got ${est}`);

  // The sign convention only matters in that correcting by `est` must work.
  const fixed = rotateGray(skewed, w, h, est);
  assert.equal(estimateSkew(fixed, w, h), 0, 'page should be level after correction');
});
