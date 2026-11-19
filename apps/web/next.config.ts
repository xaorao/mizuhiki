import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  // Public pages live at /@name. A folder cannot start with "@" in the App
  // Router (that marks a parallel-route slot), so /@name maps to /p/name.
  async rewrites() {
    return [
      { source: "/@:name", destination: "/p/:name" },
      { source: "/@:name/:path*", destination: "/p/:name/:path*" },
    ];
  },
};

export default config;
