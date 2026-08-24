import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tell Next to proxy API requests to the Fastify backend during dev so the
  // browser can call /api/* on the same origin. Production uses NEXT_PUBLIC_API_URL.
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3000";
    return [
      {
        source: "/api/chat",
        destination: `${apiUrl}/api/chat`,
      },
    ];
  },
};

export default nextConfig;