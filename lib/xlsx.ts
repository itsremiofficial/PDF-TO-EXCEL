"use client";

import type { Cell, Table } from "./extract";

export interface ExportOptions {
  headers: string[];
  rows: Cell[][];
  selected: number[];
  fileName: string;
  generatedAt?: Date;
}

export const REQUIRED_EXPORT_HEADERS = [
  "Installer Code",
  "Reward Account Title",
  "Reward Account Number",
  "Serial Number",
  "Installer Transaction ID",
  "Referrer Transaction ID",
  "Payment Method",
] as const;

const SOURCE_COLUMNS = [
  {
    canonical: "INSTALLER CODE",
    aliases: ["INSTALLER CODE"],
  },
  {
    canonical: "CUSTOMER A.C TITLE",
    aliases: [
      "CUSTOMER A.C TITLE",
      "CUSTOMER AC TITLE",
      "REWARD ACCOUNT TITLE",
    ],
  },
  {
    canonical: "CUSTOMER ACCOUNT",
    aliases: ["CUSTOMER ACCOUNT", "REWARD ACCOUNT NUMBER"],
  },
  {
    canonical: "SERIAL NUMBER",
    aliases: ["SERIAL NUMBER"],
  },
  {
    canonical: "TRAN. ID",
    aliases: ["TRAN. ID", "TRAN ID", "INSTALLER TRANSACTION ID"],
  },
] as const;

// The report used by this app has 22 columns. Its raster export makes the
// small white-on-blue headers much harder to OCR than the body, so these
// positions are a last-resort layout signature after the body has confirmed
// that this is the expected report rather than an arbitrary 22-column table.
const REPORT_SOURCE_INDEXES = [19, 9, 8, 18, 2] as const;

const REPORT_SHAPES = [
  /^[A-Z0-9]{8,12}$/i,
  /^[A-Z][A-Z ]+$/i,
  /^(?:0\d{10,13}|PK[A-Z0-9]{20,24})$/i,
  /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{12,16}$/i,
  /^\d{6}$/,
];

const normalizeHeader = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");

function matchesReportShape(
  rows: Cell[][],
  index: number,
  shape: RegExp,
): boolean {
  const values = rows
    .map((row) => row[index]?.text.trim() ?? "")
    .filter(Boolean);
  if (values.length < Math.min(3, rows.length)) return false;
  return (
    values.filter((value) => shape.test(value)).length / values.length >= 0.7
  );
}

export function resolveRequiredSourceIndexes(
  headers: string[],
  rows: Cell[][],
): number[] {
  const normalizedHeaders = headers.map(normalizeHeader);
  const indexes = SOURCE_COLUMNS.map(({ aliases }) => {
    const normalizedAliases = aliases.map(normalizeHeader);
    return normalizedHeaders.findIndex((header) =>
      normalizedAliases.includes(header),
    );
  });

  const isExpectedReport =
    headers.length === 22 &&
    REPORT_SOURCE_INDEXES.every((index, i) =>
      matchesReportShape(rows, index, REPORT_SHAPES[i]),
    );

  return indexes.map((index, i) =>
    index >= 0 ? index : isExpectedReport ? REPORT_SOURCE_INDEXES[i] : -1,
  );
}

/**
 * Reduce a recognized report to the five fields needed by the final export.
 * If the source cannot be identified safely, keep it intact so the user can
 * still inspect and adjust the extraction instead of silently remapping it.
 */
export function prepareRequiredSourceTable(table: Table): Table {
  const indexes = resolveRequiredSourceIndexes(table.headers, table.rows);
  if (indexes.some((index) => index < 0)) return table;

  return {
    ...table,
    headers: SOURCE_COLUMNS.map(({ canonical }) => canonical),
    rows: table.rows.map((row) =>
      indexes.map(
        (index) =>
          row[index] ?? {
            text: "",
            unsure: true,
            confidence: 0,
          },
      ),
    ),
  };
}

export function buildRequiredExport(
  headers: string[],
  rows: Cell[][],
  selected: number[],
): { head: string[]; body: string[][] } {
  const allowed = new Set(selected);
  const sourceIndexes = resolveRequiredSourceIndexes(headers, rows).map(
    (index) => (allowed.has(index) ? index : -1),
  );

  const body = rows.map((row) => {
    const sourceValues = sourceIndexes.map((index) =>
      index >= 0 ? (row[index]?.text ?? "") : "",
    );

    return [...sourceValues, "", "UBANK"];
  });

  return { head: [...REQUIRED_EXPORT_HEADERS], body };
}

const SOURCE_FILE_EXTENSION = /\.(pdf|png|jpe?g|bmp|webp|tiff?)$/i;

/**
 * Build a sortable, Windows-safe filename in the user's local time.
 * Example: test_2026-09-08_15-42-07_18-records.xlsx
 */
export function buildExportFileName(
  fileName: string,
  recordCount: number,
  generatedAt = new Date(),
): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [
    generatedAt.getFullYear(),
    pad(generatedAt.getMonth() + 1),
    pad(generatedAt.getDate()),
  ].join("-");
  const time = [
    pad(generatedAt.getHours()),
    pad(generatedAt.getMinutes()),
    pad(generatedAt.getSeconds()),
  ].join("-");
  const count = Math.max(0, Math.trunc(recordCount));
  // const baseName = fileName.replace(SOURCE_FILE_EXTENSION, '') || 'payment-report';
  return `payment-report_${date}_${time}_${count}-${count === 1 ? "record" : "records"}.xlsx`;
}

export async function downloadXlsx({
  headers,
  rows,
  selected,
  fileName,
  generatedAt = new Date(),
}: ExportOptions) {
  const XLSX = await import("xlsx");
  const { head, body } = buildRequiredExport(headers, rows, selected);

  const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
  ws["!cols"] = head.map((h) => ({
    wch: Math.max(14, Math.min(32, h.length + 3)),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Extracted");
  const outputFileName = buildExportFileName(
    fileName,
    body.length,
    generatedAt,
  );
  XLSX.writeFile(wb, outputFileName);
  return outputFileName;
}
