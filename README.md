# PDF table → Excel

Drop in a PDF containing a table, check the extracted values, and download an
`.xlsx` in the required installer-payment format.

Rendering, OCR and AI upscaling all run in the browser — the PDF never leaves
the machine it is opened on. The one exception is the optional "Extract with AI"
button, which sends the selected table area to Google Gemini through
`/api/gemini`. That route is the only server-side code, and it exists so the API
key stays on the server instead of shipping inside the page.

## Deploying to Vercel

```bash
npm install
npm run build
```

Push the repo and import it at [vercel.com/new](https://vercel.com/new). Vercel
detects Next.js automatically. Set `GEMINI_API_KEY` in the project's environment
variables (free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey))
to enable the AI read; everything else works without it. The app needs a Node
host for that one route, so plain static hosting will not serve it.

Local development:

```bash
cp .env.example .env.local   # then paste your GEMINI_API_KEY into it
npm run dev       # http://localhost:3000
npm test          # node's built-in runner
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

Anything still suspect is highlighted in the preview. A cell is flagged when
the three readings disagreed, or when its length or digit/letter shape differs
from the rest of its column. **Flags are a hint, not a guarantee — a confidently
wrong reading looks clean.** Every cell in the preview is editable; fix it there
and the export picks up the correction.

## Export format

The downloaded workbook always contains these columns in order:

1. `Installer Code` from `INSTALLER CODE`
2. `Reward Account Title` from `CUSTOMER A.C TITLE`
3. `Reward Account Number` from `CUSTOMER ACCOUNT`
4. `Serial Number` from `SERIAL NUMBER`
5. `Installer Transaction ID` from `TRAN. ID`
6. `Referrer Transaction ID`, left empty
7. `Payment Method`, filled with `UBANK`

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
