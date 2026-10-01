// Versioning for PCP: MAJOR.MINOR.PATCH, with package.json as the one source.
//
// MAJOR and MINOR are raised by hand on develop (`pnpm version:bump minor`) and
// arrive on main with the next merge. PATCH belongs to the release workflow
// (.github/workflows/release.yml): every push to main asks `next` for the
// version, writes it with `set`, commits, and tags it `vX.Y.Z`.
//
//   node scripts/version.mjs next               print the next release
//   node scripts/version.mjs set <x.y.z>        write it into package.json
//   node scripts/version.mjs bump major|minor   raise one and write it

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url))

/** @param {string} version */
export function parse(version) {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`Not a MAJOR.MINOR.PATCH version: ${version}`)
  return match.slice(1).map(Number)
}

/** @param {string} a @param {string} b */
export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * The version the next push to main releases. A package version above every
 * release tag is a manual MAJOR/MINOR bump (or the first release) and ships
 * as written; otherwise the highest release gets its patch raised by one.
 *
 * @param {string} packageVersion
 * @param {string[]} tags
 */
export function nextRelease(packageVersion, tags) {
  parse(packageVersion)
  const released = tags
    .filter((tag) => tag.startsWith("v") && SEMVER.test(tag.slice(1)))
    .map((tag) => tag.slice(1))
    .sort(compare)
  const latest = released.at(-1)
  if (!latest || compare(packageVersion, latest) > 0) return packageVersion
  const [major, minor, patch] = parse(latest)
  return `${major}.${minor}.${patch + 1}`
}

/**
 * @param {string} version
 * @param {string} part
 */
export function bump(version, part) {
  const [major, minor] = parse(version)
  if (part === "major") return `${major + 1}.0.0`
  if (part === "minor") return `${major}.${minor + 1}.0`
  if (part === "patch") {
    throw new Error(
      "Patch versions are set by the release workflow on main; bump major or minor.",
    )
  }
  throw new Error(`Bump major or minor, not "${part}".`)
}

function readPackage() {
  return JSON.parse(readFileSync(PACKAGE_JSON, "utf8"))
}

/** @param {string} version */
function writeVersion(version) {
  parse(version)
  const pkg = readPackage()
  pkg.version = version
  writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`)
}

function main([command, arg]) {
  const current = readPackage().version
  if (command === "next") {
    const tags = execFileSync("git", ["tag", "--list", "v*"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
    return nextRelease(current, tags)
  }
  if (command === "set") {
    writeVersion(arg)
    return arg
  }
  if (command === "bump") {
    const version = bump(current, arg)
    writeVersion(version)
    return version
  }
  throw new Error(
    "Usage: node scripts/version.mjs next | set <x.y.z> | bump <major|minor>",
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
