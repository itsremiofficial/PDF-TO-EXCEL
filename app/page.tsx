"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Upload,
  FileImage,
  FileText,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import RegionCanvas from "@/components/RegionCanvas";
import ResultTable from "@/components/ResultTable";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { analyse, guessTableRegion, type Grid, type Region } from "@/lib/grid";
import type { RenderedPage } from "@/lib/pdf";
import type { Cell, Table } from "@/lib/extract";
import { downloadXlsx, prepareRequiredSourceTable } from "@/lib/xlsx";
import { runPipeline, readRegion, type Engine } from "@/lib/pipeline";

const PREFERRED = [
  "INSTALLER CODE",
  "CUSTOMER A.C TITLE",
  "CUSTOMER ACCOUNT",
  "SERIAL NUMBER",
  "TRAN. ID",
];

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

const ENGINE_LABEL: Record<Engine, string> = {
  text: "exact from the PDF text layer",
  gemini: "read by Gemini",
  tesseract: "read locally by Tesseract",
};

export default function Home() {
  const [fileName, setFileName] = useState("");
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [gutter, setGutter] = useState(1.2);
  const abort = useRef<AbortController | null>(null);

  const report = useCallback((text: string, kind: "info" | "error" = "info") => {
    setStatus(text);
    setStatusKind(kind);
  }, []);

  const applyTable = useCallback((raw: Table) => {
    const t = prepareRequiredSourceTable(raw);
    setTable(t);
    const cols = t.headers.map((h, i) => ({ h: norm(h), i }));
    const want = PREFERRED.map(norm);
    const picks = cols.filter(
      (c) =>
        c.h &&
        want.some((w) => c.h === w || c.h.startsWith(w) || w.startsWith(c.h)),
    );
    setSelected(
      picks.length ? picks.map((p) => p.i) : t.headers.map((_, i) => i),
    );
  }, []);

  const startRun = () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setStatusKind("info");
    return ctrl;
  };

  /**
   * The whole flow, kicked off by the drop itself: render, locate the table,
   * enhance it, read it. Nothing here waits for a click.
   */
  async function onFile(file: File) {
    const ctrl = startRun();
    setFileName(file.name);
    setTable(null);
    setEngine(null);
    setSelected([]);
    setStatus("Rendering the page...");
    try {
      const res = await runPipeline(file, {
        signal: ctrl.signal,
        gutterFactor: gutter,
        onStage: (_stage, label) => setStatus(label),
        onPage: (v) => {
          setPage(v.page);
          setRegion(v.region);
          setGrid(v.grid);
        },
      });
      setPage(res.page);
      setRegion(res.region);
      setGrid(res.grid);
      setEngine(res.engine);
      applyTable(res.table);
      if (res.fallbackReason) {
        report(
          `Read locally instead of with Gemini (${res.fallbackReason})`,
          "info",
        );
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        report((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  /** Optional: re-read after the box or column sensitivity was adjusted. */
  async function reread() {
    if (!page || !region || !grid) return;
    const ctrl = startRun();
    try {
      const res = await readRegion(page, region, grid, {
        signal: ctrl.signal,
        onStage: (_stage, label) => setStatus(label),
      });
      setEngine(res.engine);
      applyTable(res.table);
    } catch (err) {
      if ((err as Error).name !== "AbortError")
        report((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const setBox = (r: Region, gf = gutter) => {
    if (!page) return;
    setRegion(r);
    setGrid(analyse(page.gray, page.width, page.height, r, { gutterFactor: gf }));
  };

  const onEdit = (ri: number, ci: number, value: string) => {
    setTable((t) => {
      if (!t) return t;
      const rows = t.rows.map((r, i) => (i === ri ? [...r] : r));
      rows[ri][ci] = { text: value.trim(), unsure: false, confidence: -1 } as Cell;
      return { ...t, rows };
    });
  };

  const flaggedCount = useMemo(
    () =>
      table
        ? table.rows.filter((r) => selected.some((i) => r[i]?.unsure)).length
        : 0,
    [table, selected],
  );

  const pickFirst = (list: FileList | null | undefined) => {
    const f = list?.[0];
    if (f) void onFile(f);
  };

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8 space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            PDF / Image table -&gt; Excel
          </h1>
          <p className="text-muted-foreground">
            Drop a PDF or image containing a table. It is straightened,
            sharpened and read automatically - the only thing left to click is
            the download. PDFs that carry their own text are read exactly and
            never leave your browser; scans and screenshots have just the table
            area sent to Google Gemini via this site&apos;s server.
          </p>
        </header>

        <div className="space-y-6">
          <Card>
            <CardContent className="pt-6">
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  pickFirst(e.dataTransfer?.files);
                }}
                className={`flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                  dragging
                    ? "border-primary bg-primary/5"
                    : "border-input bg-muted/30 hover:border-muted-foreground/30 hover:bg-muted/50"
                }`}
              >
                <input
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,image/bmp,image/webp,image/tiff"
                  className="sr-only"
                  onChange={(e) => pickFirst(e.target.files)}
                />
                {fileName ? (
                  <div className="flex items-center gap-2 text-foreground">
                    {fileName.toLowerCase().endsWith(".pdf") ? (
                      <FileText className="size-5 text-muted-foreground" />
                    ) : (
                      <FileImage className="size-5 text-muted-foreground" />
                    )}
                    <span className="font-medium">{fileName}</span>
                  </div>
                ) : (
                  <>
                    <Upload className="size-8 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      Drop a PDF or image here, or click to choose one
                    </span>
                  </>
                )}
              </label>
              {status && (
                <div className="mt-4 flex items-center gap-2">
                  {busy ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : statusKind === "error" ? (
                    <AlertCircle className="size-4 shrink-0 text-destructive" />
                  ) : (
                    <CheckCircle2 className="size-4 text-accent-green" />
                  )}
                  <p
                    className={
                      statusKind === "error"
                        ? "text-sm text-destructive"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {status}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {table && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Source columns</CardTitle>
                <CardDescription>
                  Choose the source columns used to build the required export format.
                  {engine && (
                    <Badge variant="secondary" className="ml-2">
                      {ENGINE_LABEL[engine]}
                    </Badge>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {table.headers.map((h, i) => (
                    <Badge
                      key={i}
                      variant={selected.includes(i) ? "default" : "outline"}
                      className="cursor-pointer transition-colors"
                      onClick={() =>
                        setSelected((s) =>
                          s.includes(i)
                            ? s.filter((x) => x !== i)
                            : [...s, i].sort((a, b) => a - b),
                        )
                      }
                    >
                      {h || `Column ${i + 1}`}
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(table.headers.map((_, i) => i))}
                  >
                    Select all
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected([])}
                  >
                    Clear
                  </Button>
                </div>
              </CardContent>

              <CardHeader>
                <CardTitle className="text-base">Check and export</CardTitle>
                <CardDescription>
                  Cells are editable - click to fix anything.
                  {flaggedCount > 0 && (
                    <Badge variant="destructive" className="ml-2">
                      {flaggedCount} row(s) worth checking
                    </Badge>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ResultTable
                  headers={table.headers}
                  rows={table.rows}
                  selected={selected}
                  onEdit={onEdit}
                />
                <div className="flex items-center gap-4">
                  <Button
                    disabled={!selected.length}
                    onClick={() =>
                      downloadXlsx({
                        headers: table.headers,
                        rows: table.rows,
                        selected,
                        fileName: fileName || "table",
                      })
                    }
                  >
                    <Download className="size-4" />
                    Download .xlsx
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {page && region && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    Table area{" "}
                    <span className="font-normal text-muted-foreground">
                      (only if the read looks wrong)
                    </span>
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setBox(
                          guessTableRegion(page.gray, page.width, page.height),
                        )
                      }
                    >
                      Auto-detect
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setBox({ x: 0, y: 0, w: page.width, h: page.height })
                      }
                    >
                      Whole page
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  Green lines are detected rows, red lines are column splits.
                  {grid && (
                    <Badge variant="secondary" className="ml-2">
                      {grid.rows.length} rows, {grid.columns.length} columns
                    </Badge>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <RegionCanvas
                  page={page}
                  region={region}
                  grid={grid}
                  onChange={(r) => setBox(r)}
                />

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-foreground">
                      Column sensitivity
                    </label>
                    <span className="font-mono text-sm text-muted-foreground">
                      {gutter.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    min={0.6}
                    max={2.4}
                    step={0.1}
                    value={[gutter]}
                    onValueChange={([v]) => {
                      setGutter(v);
                      setBox(region, v);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Drag left if columns are being merged, right if one column
                    is being split in two.
                  </p>
                </div>

                <Button variant="outline" disabled={busy} onClick={reread}>
                  {busy ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Working...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="size-4" />
                      Re-read this area
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </main>
  );
}
