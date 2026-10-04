import type { NextConfig } from "next"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  poweredByHeader: false,
  // Required at runtime, not bundled: better-sqlite3 is a native module;
  // the mail libraries (lib/core/mail/imap.ts) load parts of themselves
  // dynamically and only ever run on the server.
  serverExternalPackages: [
    "better-sqlite3",
    "@prisma/adapter-better-sqlite3",
    "imapflow",
    "nodemailer",
  ],
  experimental: {
    // An uploaded OpenAPI schema (up to MAX_SPEC_BYTES, 5 MB) travels in a
    // Server Action's body; Next's default limit is 1 MB. This applies to
    // every action, and is checked again per file in lib/actions/endpoints.
    serverActions: { bodySizeLimit: "6mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Browsers ignore HSTS over plain http, so this is inert on a LAN
          // and only takes effect behind a TLS proxy.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ]
  },
}

export default nextConfig
