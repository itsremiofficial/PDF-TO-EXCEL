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
      <div className="rounded-xl border border-border bg-muted/20 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">Select at least one column.</p>
      </div>
    );
  }

  return (
    <div
      className="max-h-[min(62vh,680px)] overflow-auto rounded-xl border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      tabIndex={0}
      role="region"
      aria-label={`Extracted report with ${rows.length} rows and ${selected.length} columns`}
    >
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-30 border-b border-r border-border bg-muted px-3 py-3 text-right text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              #
            </th>
            {selected.map((i) => (
              <th
                key={i}
                scope="col"
                className="sticky top-0 z-20 min-w-44 border-b border-r border-border bg-muted px-3 py-3 text-left text-xs font-semibold uppercase tracking-[0.09em] text-muted-foreground last:border-r-0"
              >
                {headers[i] || `Column ${i + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="group hover:bg-muted/25">
              <th
                scope="row"
                className="sticky left-0 z-10 w-12 border-b border-r border-border bg-card px-3 py-2.5 text-right font-mono text-xs font-normal tabular-nums text-muted-foreground group-hover:bg-muted"
              >
                {ri + 1}
              </th>
              {selected.map((ci) => {
                const cell = row[ci];
                return (
                  <td
                    key={ci}
                    className={`border-b border-r border-border p-0 last:border-r-0 ${cell?.unsure ? 'bg-amber-500/10' : 'bg-transparent'}`}
                  >
                    <div
                      className={`min-h-10 min-w-44 whitespace-nowrap px-3 py-2.5 text-foreground outline-none transition-colors focus:bg-primary/5 focus:shadow-[inset_0_0_0_2px_var(--color-ring)] ${ci === 1 ? '' : 'font-mono tabular-nums'}`}
                      contentEditable
                      suppressContentEditableWarning
                      role="textbox"
                      tabIndex={0}
                      spellCheck={false}
                      aria-label={`${headers[ci] || `Column ${ci + 1}`}, row ${ri + 1}`}
                      aria-invalid={cell?.unsure || undefined}
                      title={cell?.unsure ? 'Low confidence — check this value against the source file' : 'Click to edit'}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === 'Escape') {
                          event.currentTarget.textContent = cell?.text ?? '';
                          event.currentTarget.blur();
                        }
                      }}
                      onBlur={(event) => {
                        const value = (event.currentTarget.textContent ?? '').trim();
                        if (value !== (cell?.text ?? '')) onEdit(ri, ci, value);
                      }}
                    >
                      {cell?.text ?? ''}
                    </div>
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
