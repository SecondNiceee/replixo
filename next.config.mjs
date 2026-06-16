/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // These are all browser-only bundles — prevent the server from evaluating them.
  serverExternalPackages: ["mediasoup-client", "pdfjs-dist", "pptx-preview", "html2canvas-pro", "tldraw"],
  // Turbopack config (Next.js 16 default bundler).
  // Resolve mediasoup-client to an empty module on the server to avoid
  // the TDZ "Cannot access 'X' before initialization" SSR crash.
  turbopack: {
    resolveAlias: {
      "mediasoup-client": { browser: "mediasoup-client", default: "./lib/empty-module.js" },
    },
  },
}

export default nextConfig
