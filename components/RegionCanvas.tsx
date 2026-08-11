'use client';

import { useEffect, useRef, useState } from 'react';
import type { Grid, Region } from '@/lib/grid';

interface Props {
  page: { canvas: HTMLCanvasElement; width: number; height: number };
  region: Region;
  grid: Grid | null;
  onChange: (r: Region) => void;
}

/**
 * The page preview with a draggable table region and the inferred grid drawn
 * over it. Seeing the split lines before committing to a slow OCR pass is the
 * difference between "it got it wrong" and "drag two pixels and retry".
 */
export default function RegionCanvas({ page, region, grid, onChange }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [view, setView] = useState(1);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const maxW = Math.min(1100, cv.parentElement?.clientWidth ?? 1100);
    const s = Math.min(1, maxW / page.width);
    setView(s);
    cv.width = Math.round(page.width * s);
    cv.height = Math.round(page.height * s);

    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(page.canvas, 0, 0, cv.width, cv.height);

    // dim everything outside the region
    const r = { x: region.x * s, y: region.y * s, w: region.w * s, h: region.h * s };
    ctx.fillStyle = 'rgba(15,23,42,.55)';
    ctx.fillRect(0, 0, cv.width, r.y);
    ctx.fillRect(0, r.y + r.h, cv.width, cv.height - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, cv.width - r.x - r.w, r.h);

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    if (grid) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(34,197,94,.75)';
      for (const row of grid.rows) {
        const y = r.y + row.s * s;
        ctx.beginPath();
        ctx.moveTo(r.x + grid.minX * s, y);
        ctx.lineTo(r.x + grid.maxX * s, y);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(244,63,94,.9)';
      for (const col of grid.columns.slice(1)) {
        const x = r.x + col.x0 * s;
        ctx.beginPath();
        ctx.moveTo(x, r.y + grid.minY * s);
        ctx.lineTo(x, r.y + grid.maxY * s);
        ctx.stroke();
      }
    }

    if (drag) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.strokeRect(
        Math.min(drag.x0, drag.x1),
        Math.min(drag.y0, drag.y1),
        Math.abs(drag.x1 - drag.x0),
        Math.abs(drag.y1 - drag.y0),
      );
      ctx.setLineDash([]);
    }
  }, [page, region, grid, drag]);

  const pos = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  return (
    <canvas
      ref={ref}
      className="regionCanvas"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        const p = pos(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = pos(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const w = Math.abs(drag.x1 - drag.x0);
        const h = Math.abs(drag.y1 - drag.y0);
        setDrag(null);
        if (w < 20 || h < 20) return; // treat a tap as "no change"
        onChange({
          x: Math.round(Math.min(drag.x0, drag.x1) / view),
          y: Math.round(Math.min(drag.y0, drag.y1) / view),
          w: Math.round(w / view),
          h: Math.round(h / view),
        });
      }}
    />
  );
}
