'use client';

import type { Cell } from '@/lib/extract';

interface Props {
  headers: string[];
  rows: Cell[][];
  selected: number[];
  onEdit: (row: number, col: number, value: string) => void;
}

/**
 * Editable preview of the selected columns. Cells flagged as uncertain are
 * highlighted so a review pass has somewhere to start.
 */
export default function ResultTable({ headers, rows, selected, onEdit }: Props) {
  if (!selected.length) return <p className="muted">Select at least one column.</p>;

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th className="rowNum">#</th>
            {selected.map((i) => (
              <th key={i}>{headers[i] || `Column ${i + 1}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              <td className="rowNum">{ri + 1}</td>
              {selected.map((ci) => {
                const cell = row[ci];
                return (
                  <td
                    key={ci}
                    className={cell?.unsure ? 'unsure' : undefined}
                    title={cell?.unsure ? 'Low confidence — please check against the PDF' : undefined}
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
