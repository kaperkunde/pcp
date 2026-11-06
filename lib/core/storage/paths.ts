import { invalid } from "../errors"
import {
  MAX_GLOB_CHARS,
  MAX_NAME_BYTES,
  MAX_PATH_CHARS,
  PART_SUFFIX,
} from "./limits"

/**
 * Paths inside a storage root, worked out without touching the server. A
 * call names a path relative to the root ("scans/2026/a.pdf"; a leading
 * slash means the root too). `..` is refused outright, and what a name
 * resolves to on the server is checked again there (files.ts), so neither
 * `..` nor a symbolic link leads out.
 */

/** The names a path is made of, root first; [] is the root itself. */
export function splitPath(raw: string): string[] {
  if (raw.length > MAX_PATH_CHARS) {
    throw invalid(`A path is at most ${MAX_PATH_CHARS} characters.`)
  }

  if (raw.includes("\u0000")) {
    throw invalid("A path cannot contain a NUL character.")
  }

  const names = raw.split("/").filter((name) => name !== "" && name !== ".")

  for (const name of names) {
    if (name === "..") {
      throw invalid(
        "A path stays inside the folder: leave out .. and name the path from the folder's top.",
      )
    }

    if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) {
      throw invalid(`A name in a path is at most ${MAX_NAME_BYTES} bytes.`)
    }
  }

  return names
}

/** The path as answers show it: relative to the root, "" for the root. */
export function joinRelative(names: readonly string[]): string {
  return names.join("/")
}

/** An absolute path under a folder's real path. */
export function under(real: string, names: readonly string[]): string {
  if (names.length === 0) return real
  return `${real === "/" ? "" : real}/${names.join("/")}`
}

/** Whether `real` is the root or inside it: never a sibling like /srv/a2. */
export function isInside(rootReal: string, real: string): boolean {
  if (real === rootReal) return true
  return real.startsWith(rootReal === "/" ? "/" : `${rootReal}/`)
}

/** The names of `real` below the root, which it must be inside. */
export function relativeTo(rootReal: string, real: string): string[] {
  if (!isInside(rootReal, real)) {
    throw new Error("Outside the root.")
  }

  return real === rootReal
    ? []
    : real
        .slice(rootReal === "/" ? 1 : rootReal.length + 1)
        .split("/")
        .filter(Boolean)
}

/** A name a file is written under while it is not whole yet. */
export function isPartName(name: string): boolean {
  return name.endsWith(PART_SUFFIX)
}

/**
 * The absolute path of a storage root as the owner typed it: absolute, no
 * `..`, no trailing slash (but "/" itself, which is refused: a whole
 * machine is not a folder to share).
 */
export function normalizeRootPath(raw: string): string {
  const text = raw.trim()

  if (!text.startsWith("/")) {
    throw invalid(
      "Enter the folder's full path on the server, starting with /, like /srv/files.",
    )
  }

  const names = splitPath(text)

  if (names.length === 0) {
    throw invalid("Choose a folder, not the server's whole file system (/).")
  }

  return `/${names.join("/")}`
}

/**
 * A glob for find_files, as a test of a name: * any run of characters, ?
 * one, [abc] or [a-z] one of them ([!a] or [^a] none of them); everything
 * else as it is. Case is ignored unless `caseSensitive`.
 */
export function globMatcher(
  glob: string,
  { caseSensitive = false }: { caseSensitive?: boolean } = {},
): (name: string) => boolean {
  if (glob.length === 0 || glob.length > MAX_GLOB_CHARS) {
    throw invalid(`A name pattern is 1 to ${MAX_GLOB_CHARS} characters.`)
  }

  if (glob.includes("/")) {
    throw invalid(
      "A name pattern matches file names, without a slash: pass the folder to look in as path.",
    )
  }

  let source = ""

  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!

    if (char === "*") {
      // A run of stars is one: no backtracking to blow up.
      while (glob[index + 1] === "*") index++
      source += "[^/]*"
    } else if (char === "?") {
      source += "[^/]"
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 2)

      if (end === -1) {
        source += "\\["
        continue
      }

      let body = glob.slice(index + 1, end)
      const negate = body.startsWith("!") || body.startsWith("^")
      if (negate) body = body.slice(1)
      source += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`
      index = end
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }

  let pattern: RegExp

  try {
    pattern = new RegExp(`^${source}$`, caseSensitive ? "su" : "isu")
  } catch {
    throw invalid("That name pattern cannot be read: check its [ ] groups.")
  }

  return (name) => pattern.test(name)
}
