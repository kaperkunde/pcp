import { realpathSync } from "fs"
import { createRequire } from "module"
import type { NextConfig } from "next"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const requireHere = createRequire(import.meta.url)

/**
 * A file in an installed package, by its real path: through pnpm's
 * node_modules/<package> link, the tracing would copy it into a folder of
 * that name, which then holds nothing else. `manifest` is how the package
 * lets its package.json be required.
 */
function packageFile(manifest: string, file: string): string {
  return (
    "./" +
    path
      .relative(
        __dirname,
        path.join(
          path.dirname(realpathSync(requireHere.resolve(manifest))),
          file,
        ),
      )
      .split(path.sep)
      .join("/")
  )
}

/** patchright-core's list of browser builds. */
export const patchrightBrowsersJson = packageFile(
  "patchright-core/package.json",
  "browsers.json",
)

/**
 * sharp's WebAssembly, which its loader reads by a path it works out at
 * runtime (lib/core/code/media.ts): the tracing finds the script, not this.
 */
export const sharpWasm = packageFile(
  "@img/sharp-wasm32/package",
  `lib/sharp-wasm32-${(requireHere("@img/sharp-wasm32/package") as { version: string }).version}.node.wasm`,
)

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname),
  poweredByHeader: false,
  // A build for the e2e suite (PCP_TEST_BUILD=1 pnpm build) may be pointed
  // at the fake GitHub (lib/core/repos/github.ts fakeGitHubAllowed). The
  // value is written into the build here, so a release, built without it,
  // ignores the variable when it runs.
  env: { PCP_TEST_BUILD: process.env.PCP_TEST_BUILD === "1" ? "1" : "" },
  // Required at runtime, not bundled: better-sqlite3 is a native module;
  // acme-client (HTTPS, lib/core/network/tls.ts) brings axios and
  // node-forge, which are happier required than bundled; the mail libraries
  // (lib/core/mail/imap.ts) load parts of themselves dynamically and only
  // ever run on the server; patchright-core drives the browser's Chromium
  // (lib/core/browser/) and is never bundled; QuickJS (run_code,
  // lib/core/code/) carries its WebAssembly engine in a large script that
  // gains nothing from bundling; node-cron (the cleanup's schedule,
  // lib/core/cleanup/) ships a forking mode PCP never uses, whose worker
  // file a bundle would lose track of; ssh2 (SSH servers, lib/core/ssh/)
  // looks for optional native parts at runtime and runs without them; sharp
  // (run_code's pcp.image, lib/core/code/media.ts) finds its WebAssembly
  // build (@img/sharp-wasm32) at runtime, which loads its .wasm by path.
  serverExternalPackages: [
    "better-sqlite3",
    "@prisma/adapter-better-sqlite3",
    "acme-client",
    "imapflow",
    "nodemailer",
    "patchright-core",
    "quickjs-emscripten-core",
    "@jitl/quickjs-singlefile-cjs-release-sync",
    "node-cron",
    "ssh2",
    "sharp",
    "@img/sharp-wasm32",
  ],
  // patchright-core reads its list of browser builds with a path it works
  // out at runtime, which the file tracing cannot follow; without the file,
  // every import of it throws and the browser never starts
  // (scripts/standalone.test.ts). sharp's WebAssembly is read the same way:
  // without it, pcp.image fails in the image and the app.
  outputFileTracingIncludes: {
    "/**": [patchrightBrowsersJson, sharpWasm],
  },
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
