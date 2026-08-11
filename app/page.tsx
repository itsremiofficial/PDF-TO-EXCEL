'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import RegionCanvas from '@/components/RegionCanvas';
import ResultTable from '@/components/ResultTable';
import { analyse, type Grid, type Region } from '@/lib/grid';
import { loadDocument, renderPage, getTextItems, type RenderedPage } from '@/lib/pdf';
import {
  extractByOcr,
  extractFromText,
  flagOutliers,
  inferCharsets,
  snapLowCardinality,
  type Cell,
  type Table,
} from '@/lib/extract';
import { downloadXlsx } from '@/lib/xlsx';

const RENDER_WIDTH = 4400;

/** Columns pre-ticked when a document happens to contain them. */
const PREFERRED = [
  'INSTALLER CODE',
  'REWARD ACCOUNT TITLE',
  'CUSTOMER ACCOUNT',
  'SERIAL NUMBER',
  'TRAN. ID',
  'CUSTOMER BANK',
];

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function Home() {
  const [fileName, setFileName] = useState('');
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [textItems, setTextItems] = useState<Awaited<ReturnType<typeof getTextItems>>>([]);
  const [region, setRegion] = useState<Region | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [vote, setVote] = useState(true);
  const [review, setReview] = useState(true);
  const [gutter, setGutter] = useState(1.2);
  const abort = useRef<AbortController | null>(null);

  const hasTextLayer = textItems.length > 20;

  const recomputeGrid = useCallback((p: RenderedPage, r: Region, gf: number) => {
    const g = analyse(p.gray, p.width, p.height, r, { gutterFactor: gf });
    setGrid(g);
    return g;
  }, []);

  async function onFile(file: File) {
    setBusy(true);
    setTable(null);
    setSelected([]);
    setFileName(file.name);
    setStatus('Rendering page…');
    try {
      const doc = await loadDocument(await file.arrayBuffer());
      const pg = await doc.getPage(1);
      const rendered = await renderPage(pg, RENDER_WIDTH);
      const items = await getTextItems(pg, rendered.scale);
      setPage(rendered);
      setTextItems(items);

      setStatus('Locating the table…');
      const { guessTableRegion } = await import('@/lib/grid');
      const r = guessTableRegion(rendered.gray, rendered.width, rendered.height);
      setRegion(r);
      recomputeGrid(rendered, r, gutter);
      setStatus(
        items.length > 20
          ? 'This PDF has a text layer — extraction will be exact, no OCR needed.'
          : 'No text layer found; this page will be read with OCR.',
      );
    } catch (err) {
      setStatus(`Could not open that PDF: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function applyTable(t: Table) {
    setTable(t);
    const pref = t.headers.map((h, i) => ({ h: norm(h), i }));
    const want = PREFERRED.map(norm);
    const picks = pref.filter((c) => c.h && want.some((w) => c.h === w || c.h.startsWith(w) || w.startsWith(c.h)));
    setSelected(picks.length ? picks.map((p) => p.i) : t.headers.map((_, i) => i));
  }

  async function extract() {
    if (!page || !region) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    try {
      if (hasTextLayer) {
        setStatus('Reading the PDF text layer…');
        const t = extractFromText(textItems, region, { gutterFactor: gutter });
        if (t) {
          flagOutliers(t.headers, t.rows);
          applyTable(t);
          setStatus(`Read ${t.rows.length} rows × ${t.headers.length} columns exactly from the text layer.`);
          return;
        }
        setStatus('Text layer did not form a table; falling back to OCR…');
      }

      const g = grid ?? recomputeGrid(page, region, gutter);
      if (!g.rows.length || g.columns.length < 2) {
        setStatus('No table grid found in that region. Try dragging a tighter box around the table.');
        return;
      }

      setStatus('Reading headers…');
      const probeRows = Math.min(g.rows.length, 13);
      const probe = await extractByOcr(
        page,
        region,
        { ...g, rows: g.rows.slice(0, probeRows) },
        { vote: false, onProgress: (p) => setStatus(p.label), signal: ctrl.signal },
      );
      const charsets = inferCharsets(probe.headers, probe.rows);

      const t = await extractByOcr(page, region, g, {
        vote,
        charsets,
        onProgress: (p) => setStatus(p.label),
        signal: ctrl.signal,
      });
      snapLowCardinality(t.headers, t.rows);
      flagOutliers(t.headers, t.rows);
      applyTable(t);
      const flagged = t.rows.filter((r) => r.some((c) => c?.unsure)).length;
      setStatus(
        `Read ${t.rows.length} rows × ${t.headers.length} columns by OCR. ` +
          `${flagged} row(s) contain a low-confidence cell — check the highlighted ones.`,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setStatus(`Extraction failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const onEdit = (ri: number, ci: number, value: string) => {
    setTable((t) => {
      if (!t) return t;
      const rows = t.rows.map((r, i) => (i === ri ? [...r] : r));
      rows[ri][ci] = { text: value.trim(), unsure: false };
      return { ...t, rows };
    });
  };

  const flaggedCount = useMemo(
    () => (table ? table.rows.filter((r) => selected.some((i) => r[i]?.unsure)).length : 0),
    [table, selected],
  );

  return (
    <main>
      <header>
        <h1>PDF table → Excel</h1>
        <p className="muted">
          Drop a PDF, choose the table area, tick the columns you want, download an .xlsx.
          Everything runs in your browser — nothing is uploaded.
        </p>
      </header>

      <section className="card">
        <label className="drop">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          <span>{fileName || 'Choose a PDF…'}</span>
        </label>
        {status && <p className={busy ? 'status busy' : 'status'}>{status}</p>}
      </section>

      {page && region && (
        <section className="card">
          <div className="rowBetween">
            <h2>1. Table area</h2>
            <div className="controls">
              <button
                type="button"
                onClick={async () => {
                  const { guessTableRegion } = await import('@/lib/grid');
                  const r = guessTableRegion(page.gray, page.width, page.height);
                  setRegion(r);
                  recomputeGrid(page, r, gutter);
                }}
              >
                Auto-detect
              </button>
              <button
                type="button"
                onClick={() => {
                  const r = { x: 0, y: 0, w: page.width, h: page.height };
                  setRegion(r);
                  recomputeGrid(page, r, gutter);
                }}
              >
                Whole page
              </button>
            </div>
          </div>
          <p className="muted small">
            Drag a box around the table. Green lines are detected rows, red lines are column
            splits — if they look right, extraction will be right.
            {grid && (
              <strong>
                {' '}
                {grid.rows.length} rows, {grid.columns.length} columns.
              </strong>
            )}
          </p>
          <RegionCanvas
            page={page}
            region={region}
            grid={grid}
            onChange={(r) => {
              setRegion(r);
              recomputeGrid(page, r, gutter);
            }}
          />
          <div className="controls">
            <label className="slider">
              Column sensitivity
              <input
                type="range"
                min={0.6}
                max={2.4}
                step={0.1}
                value={gutter}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setGutter(v);
                  recomputeGrid(page, region, v);
                }}
              />
              <span className="mono">{gutter.toFixed(1)}</span>
            </label>
          </div>
          <p className="muted small">
            Drag left if columns are being merged, right if one column is being split in two.
          </p>
          <div className="controls">
            <button type="button" className="primary" disabled={busy} onClick={extract}>
              {busy ? 'Working…' : hasTextLayer ? 'Extract (exact)' : 'Extract with OCR'}
            </button>
            {!hasTextLayer && (
              <label className="check">
                <input type="checkbox" checked={vote} onChange={(e) => setVote(e.target.checked)} />
                Higher accuracy (reads each cell three times — slower)
              </label>
            )}
          </div>
          {!hasTextLayer && (
            <p className="warn">
              This PDF is an image, so every value has to be guessed by OCR. Codes like serial and
              installer numbers are the least reliable. If you can re-save the source page with
              <strong> Print → Save as PDF</strong> instead of a screenshot, this tool reads it
              exactly and instantly.
            </p>
          )}
        </section>
      )}

      {table && (
        <section className="card">
          <h2>2. Columns</h2>
          <div className="chips">
            {table.headers.map((h, i) => (
              <label key={i} className={selected.includes(i) ? 'chip on' : 'chip'}>
                <input
                  type="checkbox"
                  checked={selected.includes(i)}
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked ? [...s, i].sort((a, b) => a - b) : s.filter((x) => x !== i),
                    )
                  }
                />
                {h || `Column ${i + 1}`}
              </label>
            ))}
          </div>
          <div className="controls">
            <button type="button" onClick={() => setSelected(table.headers.map((_, i) => i))}>
              All
            </button>
            <button type="button" onClick={() => setSelected([])}>
              None
            </button>
          </div>

          <h2>3. Check and export</h2>
          <p className="muted small">
            Cells are editable — click to fix anything.
            {table.source === 'ocr' && flaggedCount > 0 && (
              <strong> {flaggedCount} row(s) have a highlighted low-confidence cell.</strong>
            )}
          </p>
          <ResultTable headers={table.headers} rows={table.rows} selected={selected} onEdit={onEdit} />
          <div className="controls">
            <button
              type="button"
              className="primary"
              disabled={!selected.length}
              onClick={() =>
                downloadXlsx({
                  headers: table.headers,
                  rows: table.rows,
                  selected,
                  fileName: fileName || 'table',
                  includeReviewColumn: review && table.source === 'ocr',
                })
              }
            >
              Download .xlsx
            </button>
            {table.source === 'ocr' && (
              <label className="check">
                <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                Include a REVIEW? column
              </label>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
