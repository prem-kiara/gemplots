/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3000';

const nextConfig = {
  reactStrictMode: true,
  // NEXT_DIST_DIR lets an ephemeral instance (e2e on :3011) use an isolated build dir so it never
  // touches the dev server's ./.next. Defaults to Next's standard '.next'.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_ORIGIN}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
