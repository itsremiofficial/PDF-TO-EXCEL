// pdf.js needs its worker served from our own origin. Copy it into public/ so
// the bundle never reaches for a CDN, and never drifts from the installed copy.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const src = join(pdfjsRoot, 'build', 'pdf.worker.min.mjs');
const destDir = join(process.cwd(), 'public');
const dest = join(destDir, 'pdf.worker.min.mjs');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-pdf-worker] ${src} -> ${dest}`);
