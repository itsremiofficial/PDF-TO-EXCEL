'use client';

import { useEffect, useRef, useState } from 'react';
import type { Grid, Region } from '@/lib/grid';

interface Props {
  page: { canvas: HTMLCanvasElement; width: number; height: number };
  region: Region;
  grid: Grid | null;
  onChange: (r: Region) => void;
}

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

    const r = { x: region.x * s, y: region.y * s, w: region.w * s, h: region.h * s };
    ctx.fillStyle = 'rgba(15,23,42,.55)';
    ctx.fillRect(0, 0, cv.width, r.y);
    ctx.fillRect(0, r.y + r.h, cv.width, cv.height - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, cv.width - r.x - r.w, r.h);

    ctx.strokeStyle = 'oklch(0.623 0.214 259.815)';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    if (grid) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'oklch(0.723 0.191 149.579)';
      for (const row of grid.rows) {
        const y = r.y + row.s * s;
        ctx.beginPath();
        ctx.moveTo(r.x + grid.minX * s, y);
        ctx.lineTo(r.x + grid.maxX * s, y);
        ctx.stroke();
      }
      ctx.strokeStyle = 'oklch(0.704 0.191 22.216)';
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
      ctx.strokeStyle = 'oklch(0.795 0.184 86.047)';
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
      className="block w-full cursor-crosshair touch-none rounded-lg border border-border"
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
        if (w < 20 || h < 20) return;
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
