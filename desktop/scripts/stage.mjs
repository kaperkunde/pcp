// Stages the server the app runs: the same files the Dockerfile copies into
// the image (the standalone output, the static assets, public/ and the
// migrations), with better-sqlite3's native binary swapped for one built for
// Electron's Node. Nothing of the app changes; the wrapper is a second host
// for the same build.
//
// Chromium, which the Dockerfile installs for the browser, is not staged:
// the app looks for one on the machine (PCP_BROWSER_EXECUTABLE, or where
// Playwright installs it), and the Browser page says how to add it.
//
//   node scripts/stage.mjs [--arch arm64|x64] [--electron-version x.y.z]
//
// Reads ../.next/standalone (run `pnpm build` at the repository root first)
// and writes ./server, plus the icon electron-builder cuts the platform icons
// from. The arch defaults to this machine's; a release build passes the one
// it packages for.

import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = fileURLToPath(new URL("..", import.meta.url))
const rootDir = path.resolve(desktopDir, "..")
const standaloneDir = path.join(rootDir, ".next", "standalone")
const serverDir = path.join(desktopDir, "server")

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { arch: process.arch, electronVersion: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arch") options.arch = argv[++i]
    else if (argv[i] === "--electron-version")
      options.electronVersion = argv[++i]
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!["arm64", "x64"].includes(options.arch)) {
    throw new Error(`--arch must be arm64 or x64, not "${options.arch}".`)
  }
  return options
}

function installedElectronVersion() {
  const pkg = createRequire(path.join(desktopDir, "package.json"))(
    "electron/package.json",
  )
  return pkg.version
}

/** Every package.json named better-sqlite3 under a directory. */
function findPackages(dir, name, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      findPackages(full, name, found)
    } else if (entry.name === "package.json") {
      try {
        if (JSON.parse(readFileSync(full, "utf8")).name === name) {
          found.push(path.dirname(full))
        }
      } catch {
        // Not a package manifest (a fixture, a file in a test); skip it.
      }
    }
  }
  return found
}

/**
 * Links in the output would be pnpm's layout showing through: a symlinked
 * node_modules works on the machine that built it, and nowhere an installer
 * puts it. The release builds install the root with pnpm's hoisted linker
 * (`pnpm install --config.node-linker=hoisted`), which lays node_modules out
 * flat, so the standalone output is plain files.
 */
function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${path.relative(desktopDir, full)} is a symlink. Install the root with \`pnpm install --config.node-linker=hoisted\` and run \`pnpm build\` again, so the standalone output holds files rather than links.`,
      )
    }
    if (entry.isDirectory()) assertNoSymlinks(full)
  }
}

function copyServer() {
  if (!existsSync(path.join(standaloneDir, "server.js"))) {
    throw new Error(
      `${standaloneDir} has no server.js. Run \`pnpm build\` at the repository root first.`,
    )
  }

  rmSync(serverDir, { recursive: true, force: true })

  // The Dockerfile's COPY lines, in order.
  const copy = (from, to) =>
    cpSync(from, to, { recursive: true, verbatimSymlinks: true })
  copy(standaloneDir, serverDir)
  copy(
    path.join(rootDir, ".next", "static"),
    path.join(serverDir, ".next", "static"),
  )
  copy(path.join(rootDir, "public"), path.join(serverDir, "public"))
  copy(
    path.join(rootDir, "prisma", "migrations"),
    path.join(serverDir, "prisma", "migrations"),
  )

  assertNoSymlinks(serverDir)
}

/**
 * better-sqlite3 is compiled against Node's ABI, and Electron's Node has a
 * different one. The standalone output carries the binary pnpm installed for
 * the Node that built it; this fetches the one for Electron (better-sqlite3
 * publishes prebuilt binaries per Electron version) and falls back to
 * compiling from source, in a scratch copy so the repository's own install
 * keeps working.
 */
function rebuildSqlite({ arch, electronVersion }) {
  const staged = findPackages(
    path.join(serverDir, "node_modules"),
    "better-sqlite3",
  )
  if (staged.length === 0) {
    throw new Error("The standalone output has no better-sqlite3 package.")
  }

  const rootRequire = createRequire(path.join(rootDir, "package.json"))
  const sourceDir = path.dirname(
    rootRequire.resolve("better-sqlite3/package.json"),
  )
  const version = JSON.parse(
    readFileSync(path.join(sourceDir, "package.json"), "utf8"),
  ).version
  for (const dir of staged) {
    const stagedVersion = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    ).version
    if (stagedVersion !== version) {
      throw new Error(
        `The staged better-sqlite3 is ${stagedVersion} but the repository has ${version}; run \`pnpm build\` again.`,
      )
    }
  }

  const scratch = path.join(
    desktopDir,
    ".cache",
    `better-sqlite3-${version}-electron-${electronVersion}-${process.platform}-${arch}`,
  )
  const binary = path.join(scratch, "build", "Release", "better_sqlite3.node")

  if (!existsSync(binary)) {
    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(scratch, { recursive: true })
    for (const name of ["package.json", "binding.gyp", "src", "deps"]) {
      cpSync(path.join(sourceDir, name), path.join(scratch, name), {
        recursive: true,
      })
    }

    const target = [
      `--runtime=electron`,
      `--target=${electronVersion}`,
      `--arch=${arch}`,
    ]

    // prebuild-install is better-sqlite3's own install step; it resolves
    // from the module's directory, wherever pnpm put it.
    const prebuildInstall = createRequire(
      path.join(sourceDir, "package.json"),
    ).resolve("prebuild-install/bin.js")
    try {
      execFileSync(
        process.execPath,
        [prebuildInstall, ...target, `--platform=${process.platform}`],
        { cwd: scratch, stdio: "inherit" },
      )
    } catch {
      console.log(
        `No prebuilt better-sqlite3 ${version} for Electron ${electronVersion} (${process.platform}-${arch}); compiling it.`,
      )
      const nodeGyp = createRequire(
        path.join(desktopDir, "package.json"),
      ).resolve("node-gyp/bin/node-gyp.js")
      execFileSync(
        process.execPath,
        [
          nodeGyp,
          "rebuild",
          "--release",
          ...target,
          "--dist-url=https://electronjs.org/headers",
          "--build-from-source",
        ],
        { cwd: scratch, stdio: "inherit" },
      )
    }
  }

  if (!existsSync(binary)) {
    throw new Error(`Expected ${binary} after the rebuild.`)
  }

  for (const dir of staged) {
    const destination = path.join(
      dir,
      "build",
      "Release",
      "better_sqlite3.node",
    )
    mkdirSync(path.dirname(destination), { recursive: true })
    cpSync(binary, destination)
  }

  return { version, binary, staged }
}

function copyIcon() {
  const source = path.join(rootDir, "assets", "icon.png")
  const destination = path.join(desktopDir, "build", "icon.png")
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const electronVersion = options.electronVersion ?? installedElectronVersion()

  copyServer()
  const sqlite = rebuildSqlite({ arch: options.arch, electronVersion })
  copyIcon()

  const size = (dir) => {
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      total += entry.isDirectory() ? size(full) : statSync(full).size
    }
    return total
  }

  console.log(
    `Staged ${path.relative(process.cwd(), serverDir) || "."} (${Math.round(size(serverDir) / 1024 / 1024)} MB) for Electron ${electronVersion} ${process.platform}-${options.arch}; better-sqlite3 ${sqlite.version} replaced in ${sqlite.staged.length} place(s).`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
