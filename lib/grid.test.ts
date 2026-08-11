// Run with: npm test  (node's built-in runner, no framework needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from './grid.ts';

/** White page with black rules and a blob of "text" inside every cell. */
function ruledTable(cols: number, rows: number, cell = 40, rule = 2) {
  const W = cols * cell + rule;
  const H = rows * cell + rule;
  const gray = new Uint8Array(W * H).fill(255);
  const paint = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) gray[y * W + x] = 0;
  };
  for (let c = 0; c <= cols; c++) paint(c * cell, 0, rule, H);
  for (let r = 0; r <= rows; r++) paint(0, r * cell, W, rule);
  // Thin, like glyph strokes: a solid block of this width would cover enough of
  // the band to be read as a filled header row and inverted.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) paint(c * cell + 8, r * cell + 14, 12, 12);
  }
  return { gray, W, H, region: { x: 0, y: 0, w: W, h: H } };
}

test('a fully ruled table yields one row and column per cell', () => {
  const { gray, W, H, region } = ruledTable(12, 20);
  const g = analyse(gray, W, H, region);
  assert.equal(g.columns.length, 12);
  assert.equal(g.rows.length, 20);
  // Cell padding must not be mistaken for glyph height, or OCR upscales wrong.
  assert.ok(g.textH <= 14, `textH ${g.textH} should be the ink height, not the row height`);
});

test('an unruled table still comes from the whitespace projection', () => {
  const cell = 40;
  const cols = 5;
  const rows = 10;
  const W = cols * cell;
  const H = rows * cell;
  const gray = new Uint8Array(W * H).fill(255);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let y = r * cell + 14; y < r * cell + 26; y++) {
        for (let x = c * cell + 8; x < c * cell + 20; x++) gray[y * W + x] = 0;
      }
    }
  }
  const g = analyse(gray, W, H, { x: 0, y: 0, w: W, h: H });
  assert.equal(g.columns.length, cols);
  assert.equal(g.rows.length, rows);
});
