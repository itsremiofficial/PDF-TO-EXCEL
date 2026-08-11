# PDF table → Excel

Drop in a PDF containing a table, drag a box around the table, tick the columns
you want, download an `.xlsx`.

Everything runs in the browser. There is no backend, no API key and no upload —
the PDF never leaves the machine it is opened on. That also means it deploys to
Vercel as plain static files, with no serverless functions and no running cost.

## Deploying to Vercel

```bash
npm install
npm run build     # emits ./out
```

Push the repo and import it at [vercel.com/new](https://vercel.com/new). Vercel
detects Next.js automatically; `next.config.mjs` sets `output: 'export'`, so the
result is a static site. No environment variables are needed.

Local development:

```bash
npm run dev       # http://localhost:3000
```

## How it reads a table

Two paths, chosen automatically.

**Text-layer PDFs (exact).** If the PDF carries real text — anything produced by
*Print → Save as PDF*, an export, or a report generator — the values are read
straight out of the file. No guessing, nothing to proofread, and it finishes
instantly.

**Image-only PDFs (OCR).** Screenshots and scans have no text layer, so every
character has to be recognised from pixels. Accuracy is good for words and poor
for dense alphanumeric codes; see the warning below.

Either way, the grid itself is worked out geometrically rather than trusted to
the OCR engine, which is what keeps values in the right columns:

1. The page is rendered at high resolution and thresholded (Otsu).
2. Full-width hairline rules are erased — they put ink in every column and would
   hide every gutter.
3. Solid-filled header bands are detected and inverted, so light-on-dark header
   text reads like everything else.
4. Rows come from horizontal whitespace bands.
5. Columns come from counting, for each x, how many rows put ink there. A
   separator is a band where that count stays *near* zero — near, not exactly,
   which is the crux: one overlong value (a filename overhanging its column)
   otherwise erases a boundary the other forty rows agree on. Requiring a
   perfectly blank gutter found only 17 of 22 real columns on the sample file;
   allowing 5% of rows to dissent found all 22.

   The minimum gutter width is expressed in multiples of text height, so it
   survives changes of font size and resolution. The *Column sensitivity*
   slider exposes that multiplier: drag left if columns are being merged, right
   if one column is being split in two.

The detected rows and columns are drawn over the page before extraction runs, so
a bad grid is visible in advance rather than discovered in the spreadsheet.

## OCR accuracy — read this before trusting the numbers

On an image-only PDF, expect Tesseract to misread some characters in dense
alphanumeric codes. The confusions are the usual ones: `0`/`O`, `1`/`I`/`L`,
`5`/`S`, `6`/`G`, `8`/`B`, `V`/`Y`. On a 3840px-wide screenshot of a dense
banking table the text is roughly 13 pixels tall, which is well below what OCR
needs to be reliable — the information simply is not in the image.

Four things reduce the damage, all automatic:

- the page renders at the source image's native resolution, and each cell is
  cropped to its ink and upscaled before recognition;
- a per-column character set is inferred from a sample, so a column of digits
  cannot come back with an `S` in it;
- each cell is read at three different upscales and the majority wins
  (the *Higher accuracy* toggle);
- columns whose values repeat — bank names, statuses — are snapped to the most
  common spelling. Columns of mostly-unique values are deliberately left alone,
  since snapping those would silently merge distinct records.

Anything still suspect is highlighted in the preview and listed in an optional
`REVIEW?` column in the spreadsheet. A cell is flagged when the three readings
disagreed, or when its length or digit/letter shape differs from the rest of its
column. **Flags are a hint, not a guarantee — a confidently wrong reading looks
clean.** Every cell in the preview is editable; fix them there and the export
picks up the correction.

> If you can obtain the same page as a real PDF rather than a screenshot — in
> the browser, `Ctrl+P` → *Save as PDF* — do that instead. The text layer is
> then read exactly, instantly, with nothing to proofread. It is by far the
> biggest accuracy win available.

## Layout

| Path | Purpose |
| --- | --- |
| `lib/grid.ts` | Rule removal, header inversion, row/column inference. Pure typed-array maths, no DOM. |
| `lib/pdf.ts` | pdf.js loading, page rasterisation, text-layer reading. |
| `lib/extract.ts` | Text-layer and OCR extraction, charset inference, confidence flagging. |
| `lib/xlsx.ts` | Sheet building and download. |
| `components/RegionCanvas.tsx` | Page preview, region dragging, grid overlay. |
| `components/ResultTable.tsx` | Editable preview with flagged cells. |

`scripts/copy-pdf-worker.mjs` copies pdf.js's worker into `public/` before dev
and build so it is served from this origin rather than a CDN. Tesseract's
worker, core and language data are fetched from a CDN on first OCR run.

## Notes

- `xlsx` (SheetJS) is pinned at `0.18.5`, the last npm release. Its known
  advisories concern *parsing* untrusted workbooks; this app only writes them.
- The preferred-column list in `app/page.tsx` (`PREFERRED`) pre-ticks columns by
  name when a document contains them. Edit it to match your own reports.
