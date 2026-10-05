// Packages the app for this platform: stages the server for the arch, then
// runs electron-builder with the version from the root package.json, so the
// app carries the release's number without anyone editing desktop/package.json.
//
//   node scripts/dist.mjs [--arch arm64|x64] [--dir]
//
// --dir leaves an unpacked app in dist/ instead of an installer, for a quick
// look. The platform is this machine's: electron-builder cross-builds for
// another arch but not another OS.
//
// Signing is by electron-builder's usual environment: CSC_LINK and
// CSC_KEY_PASSWORD for the macOS certificate, WIN_CSC_LINK and
// WIN_CSC_KEY_PASSWORD for the Windows one (never the other platform's);
// APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
// APPLE_TEAM_ID to notarize on macOS. Without a certificate the build is not
// signed by anyone, deliberately rather than by whatever identity a keychain
// happens to hold. On macOS it is then signed ad hoc: Apple silicon refuses
// to run an app with no valid signature at all, and calls a download whose
// signature is broken "damaged", with no way to open it. An ad-hoc signature
// gets the ordinary "unidentified developer" prompt and Open Anyway.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = fileURLToPath(new URL("..", import.meta.url))
const rootDir = path.resolve(desktopDir, "..")
const require = createRequire(path.join(desktopDir, "package.json"))

const SIGNING_VARIABLES = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]

function parseArgs(argv) {
  const options = { arch: process.arch, dir: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arch") options.arch = argv[++i]
    else if (argv[i] === "--dir") options.dir = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!["arm64", "x64"].includes(options.arch)) {
    throw new Error(`--arch must be arm64 or x64, not "${options.arch}".`)
  }
  return options
}

function platformFlag() {
  switch (process.platform) {
    case "darwin":
      return "--mac"
    case "win32":
      return "--win"
    case "linux":
      return "--linux"
    default:
      throw new Error(`No desktop build for ${process.platform}.`)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const version = JSON.parse(
    readFileSync(path.join(rootDir, "package.json"), "utf8"),
  ).version

  execFileSync(
    process.execPath,
    [path.join(desktopDir, "scripts", "stage.mjs"), "--arch", options.arch],
    { stdio: "inherit" },
  )

  const env = { ...process.env }
  // A workflow passes a secret that does not exist as an empty string;
  // electron-builder would take that for a certificate to load.
  for (const name of SIGNING_VARIABLES) {
    if (!env[name]?.trim()) delete env[name]
  }
  // Each platform signs with its own certificate. electron-builder falls back
  // to CSC_LINK on Windows, which would sign the installer with the Apple
  // Developer ID that Windows does not trust.
  if (process.platform === "win32") {
    delete env.CSC_LINK
    delete env.CSC_KEY_PASSWORD
  } else {
    delete env.WIN_CSC_LINK
    delete env.WIN_CSC_KEY_PASSWORD
  }
  const signing = Boolean(
    process.platform === "win32"
      ? env.WIN_CSC_LINK || env.CSC_NAME
      : env.CSC_LINK || env.CSC_NAME,
  )
  if (!signing) {
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false"
  }
  const notarize =
    signing &&
    process.platform === "darwin" &&
    Boolean(
      env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID,
    )

  // Whether the app may replace itself (main.mjs, updates.mjs). macOS lets an
  // update replace an app only when both carry the same real signature, so an
  // ad-hoc signed Mac build sends the owner to the download page instead.
  const updater = process.platform === "darwin" && !signing ? "manual" : "auto"

  const args = [
    require.resolve("electron-builder/cli.js"),
    platformFlag(),
    `--${options.arch}`,
    `--config.extraMetadata.version=${version}`,
    `--config.extraMetadata.pcpUpdater=${updater}`,
    // One update file per architecture: latest-arm64-mac.yml,
    // latest-x64-mac.yml, latest-x64.yml (Windows). main.mjs asks for the
    // same channel.
    `--config.publish.channel=latest-${options.arch}`,
    `--config.mac.notarize=${notarize}`,
    "--publish",
    "never",
  ]
  if (!signing && process.platform === "darwin") {
    args.push("--config.mac.identity=-")
  }
  if (options.dir) args.push("--dir")

  const how = signing
    ? notarize
      ? "signed and notarized"
      : "signed"
    : process.platform === "darwin"
      ? "signed ad hoc"
      : "unsigned"
  console.log(
    `Packaging PCP ${version} for ${process.platform}-${options.arch}, ${how}; updates ${updater === "auto" ? "install from the app" : "are downloaded by hand"}.`,
  )
  execFileSync(process.execPath, args, {
    cwd: desktopDir,
    env,
    stdio: "inherit",
  })
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
