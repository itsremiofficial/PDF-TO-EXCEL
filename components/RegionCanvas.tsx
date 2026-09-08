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
  const [size, setSize] = useState({ width: 0, height: 0, view: 1 });

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;

    const measure = () => {
      const width = Math.max(1, Math.min(1200, parent.clientWidth, page.width));
      const view = width / page.width;
      const height = Math.max(1, Math.round(page.height * view));
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height, view },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [page]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.width || !size.height) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(size.width * pixelRatio);
    cv.height = Math.round(size.height * pixelRatio);
    cv.style.width = `${size.width}px`;
    cv.style.height = `${size.height}px`;

    const ctx = cv.getContext('2d')!;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.drawImage(page.canvas, 0, 0, size.width, size.height);

    const r = {
      x: region.x * size.view,
      y: region.y * size.view,
      w: region.w * size.view,
      h: region.h * size.view,
    };
    ctx.fillStyle = 'rgba(15,23,42,.55)';
    ctx.fillRect(0, 0, size.width, r.y);
    ctx.fillRect(0, r.y + r.h, size.width, size.height - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, size.width - r.x - r.w, r.h);

    ctx.strokeStyle = 'oklch(0.62 0.19 258)';
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    if (grid) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'oklch(0.723 0.191 149.579)';
      for (const row of grid.rows) {
        const y = r.y + row.s * size.view;
        ctx.beginPath();
        ctx.moveTo(r.x + grid.minX * size.view, y);
        ctx.lineTo(r.x + grid.maxX * size.view, y);
        ctx.stroke();
      }
      ctx.strokeStyle = 'oklch(0.704 0.191 22.216)';
      for (const col of grid.columns.slice(1)) {
        const x = r.x + col.x0 * size.view;
        ctx.beginPath();
        ctx.moveTo(x, r.y + grid.minY * size.view);
        ctx.lineTo(x, r.y + grid.maxY * size.view);
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
  }, [page, region, grid, drag, size]);

  const pos = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  return (
    <canvas
      ref={ref}
      className="block max-w-full cursor-crosshair touch-none rounded-xl border border-border bg-white shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      role="img"
      tabIndex={0}
      aria-label="Source page with the detected table area. Drag to choose a different area."
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
        const x = Math.max(0, Math.round(Math.min(drag.x0, drag.x1) / size.view));
        const y = Math.max(0, Math.round(Math.min(drag.y0, drag.y1) / size.view));
        onChange({
          x,
          y,
          w: Math.min(page.width - x, Math.round(w / size.view)),
          h: Math.min(page.height - y, Math.round(h / size.view)),
        });
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}
