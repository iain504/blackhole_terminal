import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // v2.11.3 — smaller client bundles: bar-module imports from the two icon/chart
  // heavyweights are tree-shaken into per-icon / per-chart chunks instead of
  // the whole barrel landing in the main bundle.
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },
};

export default nextConfig;
