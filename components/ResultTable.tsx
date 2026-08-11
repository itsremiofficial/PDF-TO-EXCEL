'use client';

import type { Cell } from '@/lib/extract';

interface Props {
  headers: string[];
  rows: Cell[][];
  selected: number[];
  onEdit: (row: number, col: number, value: string) => void;
}

export default function ResultTable({ headers, rows, selected, onEdit }: Props) {
  if (!selected.length) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">Select at least one column.</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto max-h-[60vh] rounded-md border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="sticky top-0 z-10 bg-muted/50 px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              #
            </th>
            {selected.map((i) => (
              <th
                key={i}
                className="sticky top-0 z-10 bg-muted/50 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {headers[i] || `Column ${i + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border transition-colors hover:bg-muted/30 last:border-0">
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {ri + 1}
              </td>
              {selected.map((ci) => {
                const cell = row[ci];
                return (
                  <td
                    key={ci}
                    className={`px-3 py-2 transition-colors focus-within:outline-2 focus-within:outline-ring focus-within:-outline-offset-2 ${
                      cell?.unsure
                        ? 'bg-destructive/10 text-foreground'
                        : 'text-foreground'
                    }`}
                    title={cell?.unsure ? 'Low confidence - please check against the PDF' : undefined}
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => onEdit(ri, ci, e.currentTarget.textContent ?? '')}
                  >
                    {cell?.text ?? ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
