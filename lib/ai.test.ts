// Run with: npm test  (node's built-in runner, no framework needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignRows, mergeReads, parseTableJson } from './ai.ts';

test('parses bare JSON', () => {
  const { headers, rows } = parseTableJson('{"headers":["A","B"],"rows":[["1","2"]]}');
  assert.deepEqual(headers, ['A', 'B']);
  assert.deepEqual(rows, [['1', '2']]);
});

test('parses fenced JSON with surrounding prose', () => {
  const { headers, rows } = parseTableJson(
    'Here you go:\n```json\n{"headers":["A"],"rows":[["x"]]}\n```\nDone.',
  );
  assert.deepEqual(headers, ['A']);
  assert.deepEqual(rows, [['x']]);
});

test('coerces non-string cells and null to ""', () => {
  const { rows } = parseTableJson('{"headers":["A","B"],"rows":[[1,null]]}');
  assert.deepEqual(rows, [['1', '']]);
});

test('throws on malformed JSON, no JSON, and empty tables', () => {
  assert.throws(() => parseTableJson('{"headers":["A",}'), /malformed JSON/);
  assert.throws(() => parseTableJson('sorry, I cannot read that'), /did not return JSON/);
  assert.throws(() => parseTableJson('{"headers":[],"rows":[]}'), /empty table/);
});

const flags = (t: ReturnType<typeof mergeReads>) => t.rows.map((r) => r.map((c) => c.unsure));

test('mergeReads flags nothing when there is only one read', () => {
  const t = mergeReads({ headers: ['A', 'B'], rows: [['1', '2'], ['3', '4']] }, null);
  assert.deepEqual(t.rows.map((r) => r.map((c) => c.text)), [['1', '2'], ['3', '4']]);
  assert.deepEqual(flags(t), [[false, false], [false, false]]);
});

test('mergeReads flags only the cells the two reads disagree on', () => {
  const t = mergeReads(
    { headers: ['A', 'B'], rows: [['1', '2'], ['3', '4']] },
    { headers: ['A', 'B'], rows: [['1', 'X'], ['3', '4']] },
  );
  assert.deepEqual(flags(t), [[false, true], [false, false]]);
  // The first read stays the answer; the second only votes on confidence.
  assert.equal(t.rows[0][1].text, '2');
});

test('mergeReads keeps the longer read and flags only its extra rows', () => {
  const t = mergeReads(
    { headers: ['A'], rows: [['1'], ['2']] },
    { headers: ['A'], rows: [['1'], ['2'], ['3']] },
  );
  // A dropped row is the common failure, so the 3-row read wins.
  assert.deepEqual(t.rows.map((r) => r[0].text), ['1', '2', '3']);
  // Crucially not every row: the two rows both reads agree on stay clean.
  assert.deepEqual(flags(t), [[false], [false], [true]]);
});

test('mergeReads pads short rows to the header count', () => {
  const t = mergeReads({ headers: ['A', 'B', 'C'], rows: [['1']] }, null);
  assert.deepEqual(t.rows[0].map((c) => c.text), ['1', '', '']);
});

test('mergeReads survives a read that skipped one row near the top', () => {
  // The regression this guards: comparing by index shifts every row after the
  // gap, so two good reads disagreed everywhere and the whole table flagged.
  const long = { headers: ['A'], rows: [['a'], ['b'], ['c'], ['d'], ['e']] };
  const short = { headers: ['A'], rows: [['a'], ['c'], ['d'], ['e']] };
  const t = mergeReads(long, short);
  assert.deepEqual(t.rows.map((r) => r[0].text), ['a', 'b', 'c', 'd', 'e']);
  // Only the row the second read missed is flagged - not the four after it.
  assert.deepEqual(flags(t), [[false], [true], [false], [false], [false]]);
});

test('alignRows anchors on identical rows and zips the differing ones between', () => {
  const a = [['a'], ['x1'], ['c']];
  const b = [['a'], ['x2'], ['c']];
  // 'x1'/'x2' differ, but they sit between the same anchors, so they pair up
  // and get compared cell by cell rather than both being written off.
  assert.deepEqual(alignRows(a, b), [['a'], ['x2'], ['c']]);
});

test('alignRows leaves rows with no counterpart unpaired', () => {
  assert.deepEqual(alignRows([['a'], ['b']], [['a']]), [['a'], null]);
});

test('mergeReads flags a genuinely differing cell but not its neighbours', () => {
  const t = mergeReads(
    { headers: ['A', 'B'], rows: [['1', 'aa'], ['2', 'bb'], ['3', 'cc']] },
    { headers: ['A', 'B'], rows: [['1', 'aa'], ['2', 'bX'], ['3', 'cc']] },
  );
  assert.deepEqual(flags(t), [[false, false], [false, true], [false, false]]);
});
