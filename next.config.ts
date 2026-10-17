import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Full repository checks stay in CI. Next checks website entrypoints and
  // their imports, rather than repeating checks for unreferenced test/tools.
  typescript: { tsconfigPath: "tsconfig.website.json" },
  async headers() {
    return [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] }];
  },
};

export default nextConfig;
