// Builds the Touch ID keychain module (native/keychain) for this Mac and
// stages it in native-staged/, which electron-builder carries into the app's
// resources (electron-builder.yml) and touch-id.mjs loads from there. On
// another system it only leaves native-staged/ empty, so packaging needs no
// condition.
//
//   node scripts/keychain.mjs [--arch arm64|x64] [--check]
//
// Node-API is ABI-stable: a build against this Node's headers loads in
// Electron, so there is nothing to rebuild per Electron version. --check
// loads the staged module in this Node and asks it for its status, as CI
// does on macOS (where Node has no keychain entitlement, so every answer is
// errSecMissingEntitlement, and the point is that it loads and answers).

import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = fileURLToPath(new URL("..", import.meta.url))
const sourceDir = path.join(desktopDir, "native", "keychain")
const stagedDir = path.join(desktopDir, "native-staged")
const staged = path.join(stagedDir, "pcp_keychain.node")
const require = createRequire(path.join(desktopDir, "package.json"))

const MISSING_ENTITLEMENT = -34018
// What store() answers before it asks the keychain anything when there is
// no Touch ID to use, as on a CI runner.
const NOT_AVAILABLE = -25291

function parseArgs(argv) {
  const options = { arch: process.arch, check: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arch") options.arch = argv[++i]
    else if (argv[i] === "--check") options.check = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  if (!["arm64", "x64"].includes(options.arch)) {
    throw new Error(`--arch must be arm64 or x64, not "${options.arch}".`)
  }
  return options
}

function build(arch) {
  rmSync(path.join(sourceDir, "build"), { recursive: true, force: true })
  execFileSync(
    process.execPath,
    [
      require.resolve("node-gyp/bin/node-gyp.js"),
      "rebuild",
      "--release",
      `--arch=${arch}`,
    ],
    { cwd: sourceDir, stdio: "inherit" },
  )

  const built = path.join(sourceDir, "build", "Release", "pcp_keychain.node")
  if (!existsSync(built)) {
    throw new Error(`Expected ${built} after the build.`)
  }
  copyFileSync(built, staged)
}

function check() {
  const keychain = require(staged)
  const status = keychain.status()

  for (const name of ["biometrics", "entitled", "saved", "stale"]) {
    if (typeof status[name] !== "boolean") {
      throw new Error(`status().${name} is not a boolean: ${status[name]}`)
    }
  }
  if (typeof status.code !== "number") {
    throw new Error(`status().code is not a number: ${status.code}`)
  }

  // Without the entitlement nothing is stored; with it (a signed app),
  // this check is not the place to touch the owner's keychain.
  if (!status.entitled) {
    const code = keychain.store(`pcp_device_${"A".repeat(43)}`)
    if (code !== MISSING_ENTITLEMENT && code !== NOT_AVAILABLE) {
      throw new Error(
        `store() without the entitlement answered ${code}, not ${MISSING_ENTITLEMENT} or ${NOT_AVAILABLE}.`,
      )
    }
  }

  console.log(
    `The keychain module loads and answers: ${JSON.stringify(status)}`,
  )
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  rmSync(stagedDir, { recursive: true, force: true })
  mkdirSync(stagedDir, { recursive: true })

  if (process.platform !== "darwin") {
    console.log("No keychain module off macOS; native-staged/ left empty.")
    return
  }

  build(options.arch)
  console.log(`Built the keychain module for darwin-${options.arch}.`)

  if (options.check) {
    if (options.arch !== process.arch) {
      throw new Error(
        `--check loads the module here, so build it for ${process.arch}.`,
      )
    }
    check()
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
