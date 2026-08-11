/** @type {import('next').NextConfig} */
const nextConfig = {
  // Not a static export: /api/gemini needs a server so the API key never
  // reaches the browser. Everything else (rendering, OCR, upscaling) still
  // runs client-side. Deploy to a Node host (Vercel and similar); plain static
  // hosting will not serve the API route.
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
