import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  // Public pages live at /@name. A folder cannot start with "@" in the App
  // Router (that marks a parallel-route slot), so /@name maps to /p/name.
  // Baseline security headers. Nothing may frame Mizuhiki (clickjacking on the
  // signed-in app), except published forms, which owners embed on their sites.
  // When two rules set the same header, the later one wins (Next.js docs).
  async headers() {
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    ];
    const embeddable = [
      { key: "X-Frame-Options", value: "" },
      { key: "Content-Security-Policy", value: "frame-ancestors *" },
    ];
    return [
      { source: "/:path*", headers: base },
      { source: "/@:name/f/:slug", headers: embeddable },
      { source: "/p/:name/f/:slug", headers: embeddable },
    ];
  },
  async rewrites() {
    return [
      { source: "/@:name", destination: "/p/:name" },
      { source: "/@:name/:path*", destination: "/p/:name/:path*" },
    ];
  },
};

export default config;
