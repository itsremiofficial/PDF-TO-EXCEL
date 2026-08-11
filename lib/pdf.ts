'use client';

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Region } from './grid';

export interface RenderedPage {
  canvas: HTMLCanvasElement;
  gray: Uint8Array;
  width: number;
  height: number;
  scale: number;
}

/** Text drawn by the PDF itself, in the same pixel space as a RenderedPage. */
export interface TextItem {
  str: string;
  x0: number;
  x1: number;
  yMid: number;
  height: number;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

export function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

export async function loadDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
}

/**
 * Rasterise a page. `targetWidth` is capped by MAX_PIXELS because a tall
 * screenshot at full scale can otherwise ask for a canvas the browser refuses
 * to allocate.
 */
const MAX_PIXELS = 40e6;

export async function renderPage(page: PDFPageProxy, targetWidth: number): Promise<RenderedPage> {
  const base = page.getViewport({ scale: 1 });
  let scale = targetWidth / base.width;
  if (base.width * scale * base.height * scale > MAX_PIXELS) {
    scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
  }
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { toGray } = await import('./grid');
  return {
    canvas,
    gray: toGray(img.data, canvas.width, canvas.height),
    width: canvas.width,
    height: canvas.height,
    scale,
  };
}

/**
 * Text layer for a page, projected into the rendered pixel space.
 * Empty for scanned pages and screenshots, which is exactly the signal we use
 * to decide whether OCR is needed at all.
 */
export async function getTextItems(page: PDFPageProxy, scale: number): Promise<TextItem[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale });
  const out: TextItem[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    // transform is [a,b,c,d,e,f] in PDF space; e,f is the text origin.
    const [, , , , e, f] = item.transform as number[];
    const [x, y] = viewport.convertToViewportPoint(e, f);
    const w = item.width * scale;
    const h = Math.max(1, item.height * scale);
    out.push({ str: item.str, x0: x, x1: x + w, yMid: y - h / 2, height: h });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image file support — loads PNG / JPG / BMP / WebP / TIFF into the same
// RenderedPage shape so the rest of the pipeline works unchanged.
// ---------------------------------------------------------------------------

const IMAGE_TYPES = /^(image\/png|image\/jpe?g|image\/bmp|image\/webp|image\/tiff?)$/;

export function isImageFile(file: File): boolean {
  return IMAGE_TYPES.test(file.type) || /\.(png|jpe?g|bmp|webp|tiff?)$/i.test(file.name);
}

export async function loadImageFile(file: Blob, targetWidth = 4400): Promise<RenderedPage> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(targetWidth / bmp.width, 1);
  const w = Math.ceil(bmp.width * scale);
  const h = Math.ceil(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const img = ctx.getImageData(0, 0, w, h);
  const { toGray } = await import('./grid');
  return { canvas, gray: toGray(img.data, w, h), width: w, height: h, scale };
}
