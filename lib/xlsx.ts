'use client';

import type { Cell } from './extract';

export interface ExportOptions {
  headers: string[];
  rows: Cell[][];
  selected: number[];
  fileName: string;
  includeReviewColumn: boolean;
}

export async function downloadXlsx({
  headers,
  rows,
  selected,
  fileName,
  includeReviewColumn,
}: ExportOptions) {
  const XLSX = await import('xlsx');

  const cols = selected.map((i) => headers[i] || `Column ${i + 1}`);
  const head = includeReviewColumn ? [...cols, 'REVIEW?'] : cols;

  const body = rows.map((r) => {
    const values = selected.map((i) => r[i]?.text ?? '');
    if (!includeReviewColumn) return values;
    const flagged = selected.filter((i) => r[i]?.unsure).map((i) => headers[i] || `Column ${i + 1}`);
    return [...values, flagged.join(', ')];
  });

  const ws = XLSX.utils.aoa_to_sheet([head, ...body]);
  ws['!cols'] = head.map((h) => ({ wch: Math.max(14, Math.min(40, h.length + 4)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Extracted');
  XLSX.writeFile(wb, fileName.replace(/\.pdf$/i, '') + '.xlsx');
}
