// Run with: npm test  (node's built-in runner, no framework needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromText } from './extract.ts';
import type { Grid } from './grid.ts';
import type { TextItem } from './pdf.ts';

const item = (str: string, x0: number, y: number, w = str.length * 8): TextItem => ({
  str,
  x0,
  x1: x0 + w,
  yMid: y,
  height: 10,
});

/** RNUM and TRAN. ID sit close enough to leave no gutter between them. */
const page = (): TextItem[] => {
  const out = [
    item('RNUM', 10, 0),
    item('TRAN. ID', 46, 0),
    item('NAME', 200, 0),
    item('AMOUNT', 300, 0),
    item('BANK', 400, 0),
  ];
  for (let r = 1; r <= 6; r++) {
    out.push(
      item(String(r), 10, r * 20, 32),
      item(String(230900 + r), 46, r * 20),
      item(`NAME ${r}`, 200, r * 20),
      item('5000', 300, r * 20),
      item('UBL', 400, r * 20),
    );
  }
  return out;
};

const region = { x: 0, y: -10, w: 600, h: 200 };

test('touching columns merge without a grid and split with one', () => {
  const without = extractFromText(page(), region);
  assert.ok(without);
  assert.equal(without.headers[0], 'RNUM TRAN. ID');

  const grid = {
    columns: [
      { x0: 0, x1: 44 },
      { x0: 44, x1: 195 },
      { x0: 195, x1: 295 },
      { x0: 295, x1: 395 },
      { x0: 395, x1: 600 },
    ],
    rows: [],
  } as unknown as Grid;
  const withGrid = extractFromText(page(), region, { grid });
  assert.ok(withGrid);
  assert.deepEqual(withGrid.headers, ['RNUM', 'TRAN. ID', 'NAME', 'AMOUNT', 'BANK']);
  assert.deepEqual(
    withGrid.rows.map((r) => r.map((c) => c.text)),
    Array.from({ length: 6 }, (_, i) => [String(i + 1), String(230901 + i), `NAME ${i + 1}`, '5000', 'UBL']),
  );
});

test('a title line above the table is not taken for the header row', () => {
  const items = [item('Total Record: 6, Batch Amount: 30000', 10, -30, 120), ...page()];
  const t = extractFromText(items, { x: 0, y: -40, w: 600, h: 240 });
  assert.ok(t);
  assert.ok(t.headers[0].startsWith('RNUM'), `headers were ${JSON.stringify(t.headers)}`);
  assert.equal(t.rows.length, 6);
});
