/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // mediasoup-client is a browser-only CJS bundle — exclude it from the
  // server build entirely so Turbopack / webpack never tries to parse it
  // on the Node side (which causes the "Cannot access 'X' before
  // initialization" TDZ error).
  serverExternalPackages: ["mediasoup-client"],
  webpack(config, { isServer }) {
    if (isServer) {
      // Replace mediasoup-client with an empty module on the server so any
      // accidental server-side import doesn't crash the build.
      config.resolve.alias = {
        ...config.resolve.alias,
        "mediasoup-client": false,
      }
    }
    return config
  },
}

export default nextConfig
