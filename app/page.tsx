"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import RegionCanvas from "@/components/RegionCanvas";
import ResultTable from "@/components/ResultTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  extractFromText,
  flagOutliers,
  type Cell,
  type Table,
} from "@/lib/extract";
import { analyse, guessTableRegion, type Grid, type Region } from "@/lib/grid";
import type { RenderedPage, TextItem } from "@/lib/pdf";
import {
  readRegion,
  runPipeline,
  type Engine,
  type Stage,
} from "@/lib/pipeline";
import {
  buildExportFileName,
  downloadXlsx,
  prepareRequiredSourceTable,
} from "@/lib/xlsx";

const PREFERRED = [
  "INSTALLER CODE",
  "CUSTOMER A.C TITLE",
  "CUSTOMER ACCOUNT",
  "SERIAL NUMBER",
  "TRAN. ID",
];

const ACCEPTED_FILE = /\.(pdf|png|jpe?g|bmp|webp|tiff?)$/i;
const norm = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

const ENGINE_LABEL: Record<Engine, string> = {
  text: "Exact PDF text",
  gemini: "Gemini OCR",
  tesseract: "Local OCR",
};

const STEPS = ["Upload", "Review", "Export"];

function formatBytes(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [textItems, setTextItems] = useState<TextItem[]>([]);
  const [region, setRegion] = useState<Region | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"info" | "success" | "error">(
    "info",
  );
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [exportTimestamp, setExportTimestamp] = useState<Date | null>(null);
  const [dragging, setDragging] = useState(false);
  const [gutter, setGutter] = useState(1.2);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastProgressAt = useRef(0);

  const report = useCallback(
    (text: string, kind: "info" | "success" | "error" = "info") => {
      setStatus(text);
      setStatusKind(kind);
    },
    [],
  );

  const reportStage = useCallback(
    (stage: Stage, label: string) => {
      const now = performance.now();
      if (
        label.startsWith("Reading cells") &&
        now - lastProgressAt.current < 100
      )
        return;
      lastProgressAt.current = now;
      report(label, stage === "done" ? "success" : "info");
    },
    [report],
  );

  const applyTable = useCallback((raw: Table) => {
    const prepared = prepareRequiredSourceTable(raw);
    setTable(prepared);
    const columns = prepared.headers.map((header, index) => ({
      header: norm(header),
      index,
    }));
    const wanted = PREFERRED.map(norm);
    const picks = columns.filter(
      (column) =>
        column.header &&
        wanted.some(
          (candidate) =>
            column.header === candidate ||
            column.header.startsWith(candidate) ||
            candidate.startsWith(column.header),
        ),
    );
    setSelected(
      picks.length
        ? picks.map((column) => column.index)
        : prepared.headers.map((_, index) => index),
    );
    setDownloaded(false);
    setExportTimestamp(new Date());
    return prepared;
  }, []);

  const startRun = () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatusKind("info");
    return controller;
  };

  const resetResults = () => {
    setPage(null);
    setTextItems([]);
    setRegion(null);
    setGrid(null);
    setTable(null);
    setEngine(null);
    setSelected([]);
    setDownloaded(false);
    setExportTimestamp(null);
  };

  async function onFile(file: File) {
    if (!ACCEPTED_FILE.test(file.name)) {
      report("Choose a PDF, PNG, JPG, BMP, WebP, or TIFF file.", "error");
      return;
    }

    const controller = startRun();
    setFileName(file.name);
    setFileSize(file.size);
    resetResults();
    report("Preparing your report…");

    try {
      const result = await runPipeline(file, {
        signal: controller.signal,
        gutterFactor: gutter,
        onStage: reportStage,
        onPage: (view) => {
          setPage(view.page);
          setTextItems(view.textItems);
          setRegion(view.region);
          setGrid(view.grid);
        },
      });
      setPage(result.page);
      setTextItems(result.textItems);
      setRegion(result.region);
      setGrid(result.grid);
      setEngine(result.engine);
      const prepared = applyTable(result.table);
      report(
        `${prepared.rows.length} rows are ready to review${result.fallbackReason ? " (processed locally)" : ""}.`,
        "success",
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        report((error as Error).message, "error");
      }
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }

  async function reread() {
    if (!page || !region || !grid) return;
    const controller = startRun();
    setDownloaded(false);

    try {
      if (textItems.length > 20) {
        report("Reading the adjusted area from the PDF text layer…");
        const exact = extractFromText(textItems, region, {
          gutterFactor: gutter,
          grid,
        });
        if (exact) {
          flagOutliers(exact.headers, exact.rows);
          setEngine("text");
          const prepared = applyTable(exact);
          report(
            `${prepared.rows.length} rows were re-read exactly.`,
            "success",
          );
          return;
        }
      }

      const result = await readRegion(page, region, grid, {
        signal: controller.signal,
        onStage: reportStage,
      });
      setEngine(result.engine);
      const prepared = applyTable(result.table);
      report(
        `${prepared.rows.length} rows were re-read and are ready.`,
        "success",
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        report((error as Error).message, "error");
      }
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }

  const setBox = (nextRegion: Region, nextGutter = gutter) => {
    if (!page) return;
    setRegion(nextRegion);
    setGrid(
      analyse(page.gray, page.width, page.height, nextRegion, {
        gutterFactor: nextGutter,
      }),
    );
    setDownloaded(false);
  };

  const onEdit = (rowIndex: number, columnIndex: number, value: string) => {
    setTable((current) => {
      if (!current) return current;
      const rows = current.rows.map((row, index) =>
        index === rowIndex ? [...row] : row,
      );
      rows[rowIndex][columnIndex] = {
        text: value.trim(),
        unsure: false,
        confidence: -1,
      } as Cell;
      return { ...current, rows };
    });
    setDownloaded(false);
  };

  async function handleDownload() {
    if (!table || !selected.length) return;
    setDownloading(true);
    try {
      const generatedAt = new Date();
      const downloadedFileName = await downloadXlsx({
        headers: table.headers,
        rows: table.rows,
        selected,
        fileName: fileName || "installer-report",
        generatedAt,
      });
      setExportTimestamp(generatedAt);
      setDownloaded(true);
      report(`${downloadedFileName} downloaded.`, "success");
    } catch (error) {
      report(
        `Could not create the Excel file: ${(error as Error).message}`,
        "error",
      );
    } finally {
      setDownloading(false);
    }
  }

  const flaggedCount = useMemo(
    () =>
      table
        ? table.rows.filter((row) =>
            selected.some((index) => row[index]?.unsure),
          ).length
        : 0,
    [table, selected],
  );

  const pickFirst = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file) void onFile(file);
  };

  const stopRun = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    report("Processing stopped. Choose the file again when you’re ready.");
  };

  const completedStep = downloaded ? 3 : table ? 2 : fileName ? 1 : 0;
  const exportFileName = table
    ? buildExportFileName(
        fileName,
        table.rows.length,
        exportTimestamp ?? new Date(),
      )
    : "";

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <header className="mb-8 border-b border-border/70 pb-7 sm:mb-10 sm:pb-9">
          <div className="mb-8 flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <FileSpreadsheet className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  Report Formatter
                </p>
                <p className="text-xs text-muted-foreground">PDF to Excel</p>
              </div>
            </div>
            <Badge
              variant="outline"
              className="hidden gap-1.5 bg-card/80 px-3 py-1.5 sm:inline-flex"
            >
              <ShieldCheck
                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              Local-first processing
            </Badge>
          </div>

          <div className="max-w-3xl">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Installer payment reports
            </p>
            <h1 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-5xl">
              Turn installer reports into clean Excel files.
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
              Upload one PDF or image. We extract the required fields, arrange
              them in the correct order, and prepare a seven-column workbook.
            </p>
          </div>

          <ol
            aria-label="Conversion progress"
            className="mt-8 grid  w-full grid-cols-3 gap-2 sm:mt-10 sm:gap-4"
          >
            {STEPS.map((step, index) => {
              const position = index + 1;
              const complete = completedStep >= position;
              const active = completedStep + 1 === position;
              return (
                <li key={step} className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${complete ? "bg-primary text-primary-foreground" : active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                    >
                      {complete ? (
                        <Check className="size-3" aria-hidden="true" />
                      ) : (
                        position
                      )}
                    </span>
                    <span
                      className={`truncate text-xs font-medium sm:text-sm ${active || complete ? "text-foreground" : "text-muted-foreground"}`}
                    >
                      {step}
                    </span>
                  </div>
                  <div
                    className={`mt-2 h-1 rounded-full ${complete ? "bg-primary" : active ? "bg-primary/30" : "bg-muted"}`}
                  />
                </li>
              );
            })}
          </ol>
        </header>

        <div className="space-y-5 sm:space-y-6">
          <input
            ref={inputRef}
            id="report-upload"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/bmp,image/webp,image/tiff"
            className="sr-only"
            onChange={(event) => {
              pickFirst(event.target.files);
              event.currentTarget.value = "";
            }}
          />

          {!fileName ? (
            <Card className="overflow-hidden border-border/80 shadow-sm">
              <CardContent className="p-3 sm:p-4">
                <label
                  htmlFor="report-upload"
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    pickFirst(event.dataTransfer?.files);
                  }}
                  className={`group flex min-h-64 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center transition-colors sm:min-h-72 ${
                    dragging
                      ? "border-primary bg-primary/5"
                      : "border-border bg-muted/25 hover:border-primary/50 hover:bg-muted/45"
                  }`}
                >
                  <div className="mb-5 grid size-14 place-items-center rounded-2xl border border-border bg-card text-primary shadow-sm transition-transform group-hover:-translate-y-0.5">
                    <Upload className="size-6" aria-hidden="true" />
                  </div>
                  <span className="text-lg font-semibold text-foreground">
                    Drop your report here
                  </span>
                  <span className="mt-1.5 text-sm text-muted-foreground">
                    or click to choose a file
                  </span>
                  <span className="mt-5 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
                    PDF, PNG, JPG, BMP, WebP or TIFF
                  </span>
                </label>
              </CardContent>
            </Card>
          ) : (
            <Card
              className="overflow-hidden border-border/80 shadow-sm"
              aria-busy={busy}
            >
              {busy && (
                <div
                  className="h-1 overflow-hidden bg-primary/10"
                  aria-hidden="true"
                >
                  <div className="processing-bar h-full w-1/3 bg-primary" />
                </div>
              )}
              <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                    {fileName.toLowerCase().endsWith(".pdf") ? (
                      <FileText className="size-5" aria-hidden="true" />
                    ) : (
                      <FileImage className="size-5" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {fileName}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[
                        formatBytes(fileSize),
                        busy
                          ? "Processing"
                          : table
                            ? "Ready to review"
                            : "Uploaded",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {busy ? (
                    <Button variant="outline" size="sm" onClick={stopRun}>
                      <X className="size-4" aria-hidden="true" />
                      Stop
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => inputRef.current?.click()}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      Replace file
                    </Button>
                  )}
                </div>
              </CardContent>
              {status && (
                <div
                  className={`flex items-start gap-2 border-t px-4 py-3 text-sm sm:px-5 ${statusKind === "error" ? "border-destructive/20 bg-destructive/5 text-destructive" : statusKind === "success" ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : "border-border bg-muted/25 text-muted-foreground"}`}
                  role={statusKind === "error" ? "alert" : "status"}
                  aria-live="polite"
                >
                  {busy ? (
                    <Loader2
                      className="mt-0.5 size-4 shrink-0 animate-spin"
                      aria-hidden="true"
                    />
                  ) : statusKind === "error" ? (
                    <AlertCircle
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <p className="leading-5">{status}</p>
                </div>
              )}
            </Card>
          )}

          {table && (
            <Card className="overflow-hidden border-border/80 shadow-sm p-0">
              <CardHeader className="gap-4 border-b border-border/70 px-4 py-5 sm:flex sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div>
                  <CardTitle className="text-lg">
                    Review extracted data
                  </CardTitle>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                    Select any cell to correct it before downloading.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {engine && (
                    <Badge variant="secondary">{ENGINE_LABEL[engine]}</Badge>
                  )}
                  {flaggedCount > 0 ? (
                    <Badge
                      variant="outline"
                      className="gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                    >
                      <AlertTriangle className="size-3" aria-hidden="true" />
                      {flaggedCount} {flaggedCount === 1 ? "row" : "rows"} to
                      check
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    >
                      <CheckCircle2 className="size-3" aria-hidden="true" />
                      Checks passed
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-5 p-4 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {table.rows.length}
                    </span>{" "}
                    rows ·{" "}
                    <span className="font-medium text-foreground">
                      {table.headers.length}
                    </span>{" "}
                    source columns
                  </p>
                  <p className="text-xs text-muted-foreground sm:hidden">
                    Swipe to view all columns
                  </p>
                </div>
                <ResultTable
                  headers={table.headers}
                  rows={table.rows}
                  selected={selected}
                  onEdit={onEdit}
                />
                <div className="flex flex-col gap-4 border-t border-border/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {exportFileName}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      7 columns · Referrer Transaction ID blank · Payment
                      Method: UBANK
                    </p>
                  </div>
                  <Button
                    className="w-full sm:w-auto"
                    size="lg"
                    disabled={!selected.length || downloading}
                    onClick={handleDownload}
                  >
                    {downloading ? (
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : downloaded ? (
                      <Check className="size-4" aria-hidden="true" />
                    ) : (
                      <Download className="size-4" aria-hidden="true" />
                    )}
                    {downloading
                      ? "Preparing…"
                      : downloaded
                        ? "Downloaded"
                        : "Download Excel"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {page && region && (
            <details className="group overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/35 sm:px-6">
                <span className="flex items-center gap-2.5">
                  <SlidersHorizontal
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  Extraction settings
                  <span className="hidden font-normal text-muted-foreground sm:inline">
                    Use only if the table was read incorrectly
                  </span>
                </span>
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="space-y-5 border-t border-border/70 p-4 sm:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Detected table area
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Green lines mark rows; red lines mark column splits.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {grid && (
                      <Badge variant="secondary">
                        {grid.rows.length} rows · {grid.columns.length} columns
                      </Badge>
                    )}
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

                <RegionCanvas
                  page={page}
                  region={region}
                  grid={grid}
                  onChange={(nextRegion) => setBox(nextRegion)}
                />

                <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <label
                      htmlFor="column-sensitivity"
                      className="text-sm font-medium text-foreground"
                    >
                      Column sensitivity
                    </label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {gutter.toFixed(1)}
                    </span>
                  </div>
                  <Slider
                    id="column-sensitivity"
                    min={0.6}
                    max={2.4}
                    step={0.1}
                    value={[gutter]}
                    onValueChange={([value]) => setGutter(value)}
                    onValueCommit={([value]) => setBox(region, value)}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Move left if columns are merged, or right if one column is
                    split in two.
                  </p>
                </div>

                <Button variant="outline" disabled={busy} onClick={reread}>
                  {busy ? (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                  {busy ? "Working…" : "Re-read selection"}
                </Button>
              </div>
            </details>
          )}
        </div>

        <footer className="mt-8 flex flex-col gap-2 border-t border-border/70 pt-5 text-xs leading-5 text-muted-foreground sm:mt-10 sm:flex-row sm:items-center sm:justify-between">
          <p>Built for a consistent seven-column payment import.</p>
          <p>Text PDFs stay in your browser; scans may use Gemini OCR.</p>
        </footer>
      </div>
    </main>
  );
}
