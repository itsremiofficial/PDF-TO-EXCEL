/** @type {import('next').NextConfig} */
const nextConfig = {
  // Everything runs in the browser, so the whole thing ships as static files.
  // No serverless functions, no API keys, no request-body limits on Vercel.
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
