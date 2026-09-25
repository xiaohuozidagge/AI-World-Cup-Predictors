import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: `next build` emits a self-contained `out/` directory with no
  // server, no Node runtime and no API routes. Deploy = upload `out/`.
  output: "export",

  // The default `next/image` optimizer needs a server; crests and OG images are
  // served as plain local assets instead.
  images: {
    unoptimized: true,
  },

  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
