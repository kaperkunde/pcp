import type { NextConfig } from "next"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  poweredByHeader: false,
  // Required at runtime, not bundled: better-sqlite3 is a native module;
  // acme-client (HTTPS, lib/core/network/tls.ts) brings axios and
  // node-forge, which are happier required than bundled; the mail libraries
  // (lib/core/mail/imap.ts) load parts of themselves dynamically and only
  // ever run on the server; playwright-core drives the browser's Chromium
  // (lib/core/browser/) and is never bundled; QuickJS (run_code,
  // lib/core/code/) carries its WebAssembly engine in a large script that
  // gains nothing from bundling.
  serverExternalPackages: [
    "better-sqlite3",
    "@prisma/adapter-better-sqlite3",
    "acme-client",
    "imapflow",
    "nodemailer",
    "playwright-core",
    "quickjs-emscripten-core",
    "@jitl/quickjs-singlefile-cjs-release-sync",
  ],
  experimental: {
    // An uploaded OpenAPI schema (up to MAX_SPEC_BYTES, 5 MB) and an export
    // file to restore (up to MAX_EXPORT_FILE_BYTES, 64 MB) travel in a
    // Server Action's body; Next's default limit is 1 MB. This applies to
    // every action, and each checks its own file's size again before
    // reading it (lib/actions/endpoints.ts, lib/actions/backup.ts).
    serverActions: { bodySizeLimit: "70mb" },
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
