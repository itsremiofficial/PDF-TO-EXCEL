import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Not a static export: /api/gemini needs a server so the API key never
  // reaches the browser. Everything else (rendering, OCR, upscaling) still
  // runs client-side. Deploy to a Node host (Vercel and similar); plain static
  // hosting will not serve the API route.
  reactStrictMode: true,
  images: { unoptimized: true },
};

// Development and production builds must not write to the same directory.
// Otherwise `next build` can replace hashed browser chunks while `next dev`
// is still serving a page that references them, causing ChunkLoadError for
// dynamically imported modules such as pdfjs-dist.
export default (phase) => ({
  ...nextConfig,
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
});
