import { invalid } from "../errors"
import { hiddenCharacter } from "../memories"

import {
  MAX_FILE_BYTES,
  MAX_ITEM_BYTES,
  MAX_ITEM_FILES,
  MAX_ITEM_NAME_CHARS,
  MAX_PATH_CHARS,
  MAX_SPEC_FILE_BYTES,
} from "./limits"

/**
 * Where a shared item's files are in a linked repository. Plain folders
 * and native formats, with names a person reads, and nothing else: no
 * index, no manifest. A file belongs to the item its path names:
 *
 *   skills/<name>/SKILL.md          a skill, as an Agent Skill is laid out
 *   skills/<name>/<file>            its reference files, as they are
 *   wrappers/<name>/wrapper.yaml    a wrapper
 *   wrappers/<name>/<tool>.js       the program of each of its tools
 *   flows/<name>/…                  a browser flow: a wrapper that drives
 *                                   the browser, laid out as one
 *   endpoints/<name>/openapi.json   an API endpoint's OpenAPI document as
 *   endpoints/<name>/openapi.yaml     PCP holds it, JSON or YAML
 *   endpoints/<name>/pcp.yaml       what PCP adds to it
 *   servers/<name>.yaml             an MCP server
 *   services/<name>.yaml            a service: a container's definition
 *                                   (image by digest, ports, variable
 *                                   names, volumes, health, what it
 *                                   registers); format 3 and later. An
 *                                   older PCP knows no services/ folder
 *                                   and leaves it alone, as any other.
 *
 * Anything else in the repository (a README, a licence, CI) is no item's
 * and is left alone. Names are slugs: lower-case letters, digits and single
 * dashes. Wrappers, flows, endpoints, servers and services are all servers
 * in a vault,
 * where a slug names one, so one name is one of them only.
 */

export type ItemKind =
  "skill" | "wrapper" | "flow" | "endpoint" | "server" | "service"

/** An item in a repository: its kind and its name (a slug). */
export type ItemRef = { kind: ItemKind; name: string }

/** A set of files, by path from the repository's root. */
export type RepoFiles = Record<string, string>

export const ITEM_DIRS: Record<ItemKind, string> = {
  skill: "skills",
  wrapper: "wrappers",
  flow: "flows",
  endpoint: "endpoints",
  server: "servers",
  service: "services",
}

export const SKILL_MD = "SKILL.md"
export const WRAPPER_YAML = "wrapper.yaml"
export const ENDPOINT_YAML = "pcp.yaml"
export const SPEC_JSON = "openapi.json"
export const SPEC_YAML = "openapi.yaml"
export const PROGRAM_EXTENSION = ".js"

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** Whether two kinds share the vault's server names. */
function isServerKind(kind: ItemKind): boolean {
  return kind !== "skill"
}

/** An item's name, checked: a slug, as a path holds it. */
export function checkItemName(input: string): string {
  if (input.length > MAX_ITEM_NAME_CHARS || !SLUG.test(input)) {
    throw invalid(
      `"${input.slice(0, MAX_ITEM_NAME_CHARS)}" is not a name a repository's item has: lower-case letters, digits and single dashes, at most ${MAX_ITEM_NAME_CHARS} characters.`,
    )
  }

  return input
}

/**
 * The slug an item's name gives: lower case, letters and digits with single
 * dashes between them, accents dropped (as servers.ts slugify does).
 */
export function itemSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ITEM_NAME_CHARS)
    .replace(/-+$/, "")

  if (!slug) {
    throw invalid(`"${name.slice(0, 80)}" gives no name for a repository.`)
  }

  return slug
}

/** How sets and maps tell items apart. */
export function itemKey(ref: ItemRef): string {
  return `${ref.kind}:${ref.name}`
}

/** The kinds whose item is one file, `<dir>/<name>.yaml`, not a folder. */
export function isOneFileKind(kind: ItemKind): kind is "server" | "service" {
  return kind === "server" || kind === "service"
}

/** An item's folder, or a server's or service's one file. */
export function itemRoot(ref: ItemRef): string {
  return isOneFileKind(ref.kind)
    ? `${ITEM_DIRS[ref.kind]}/${ref.name}.yaml`
    : `${ITEM_DIRS[ref.kind]}/${ref.name}`
}

/** The path of one of an item's files, from the repository's root. */
export function itemPath(ref: ItemRef, file: string): string {
  return isOneFileKind(ref.kind) ? itemRoot(ref) : `${itemRoot(ref)}/${file}`
}

/**
 * A path from a repository, checked before anything reads the file: relative,
 * with / between plain names, none of them "." or "..", nothing hidden, and
 * not too long.
 */
export function checkRepoPath(path: string): string {
  if (!path || path.length > MAX_PATH_CHARS) {
    throw invalid(
      `A file's path in a repository is 1 to ${MAX_PATH_CHARS} characters: "${path.slice(0, 80)}…" is not.`,
    )
  }

  const hidden = hiddenCharacter(path)

  if (hidden) {
    throw invalid(
      `The path "${path.slice(0, 80)}" has a character that does not show on screen (${hidden}).`,
    )
  }

  if (path.includes("\\") || path.includes("\n") || path.includes("\t")) {
    throw invalid(`The path "${path}" is not a plain path.`)
  }

  const segments = path.split("/")

  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /^\.+$/.test(segment),
    )
  ) {
    throw invalid(
      `The path "${path}" leaves its folder or is not a plain path: no leading /, no empty names, no "." or "..".`,
    )
  }

  return path
}

/**
 * The item a path belongs to, and the file's name inside it; null for a path
 * that is no item's (a README, a licence). The path is checked first.
 */
export function itemOfPath(
  path: string,
): { ref: ItemRef; file: string } | null {
  const segments = checkRepoPath(path).split("/")
  const [top, second, ...rest] = segments
  const kind = (Object.keys(ITEM_DIRS) as ItemKind[]).find(
    (candidate) => ITEM_DIRS[candidate] === top,
  )

  // A dotfile (.gitkeep, .DS_Store) is the repository's, not an item's.
  if (
    !kind ||
    second === undefined ||
    [second, ...rest].some((segment) => segment.startsWith("."))
  ) {
    return null
  }

  if (isOneFileKind(kind)) {
    if (rest.length > 0 || !second.endsWith(".yaml")) {
      throw invalid(
        `${path}: ${kind === "server" ? "an MCP server" : "a service"} is one file, ${ITEM_DIRS[kind]}/<name>.yaml.`,
      )
    }

    return {
      ref: { kind, name: checkItemName(second.slice(0, -".yaml".length)) },
      file: second,
    }
  }

  if (rest.length === 0) {
    throw invalid(
      `${path}: a ${kind}'s files go in a folder of its own, ${ITEM_DIRS[kind]}/<name>/.`,
    )
  }

  for (const segment of rest) {
    if (!SEGMENT.test(segment)) {
      throw invalid(
        `${path}: file names are letters, digits, dots, dashes and underscores.`,
      )
    }
  }

  return { ref: { kind, name: checkItemName(second) }, file: rest.join("/") }
}

/** What an item's files are, by kind, for itemPaths. */
export type ItemShape =
  | { kind: "skill"; name: string; files: string[] }
  | { kind: "wrapper" | "flow"; name: string; tools: string[] }
  | { kind: "endpoint"; name: string; spec: "json" | "yaml" }
  | { kind: "server" | "service"; name: string }

/** The file a wrapper tool's program is in. */
export function programFile(tool: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(tool)) {
    throw invalid(
      `The tool "${tool.slice(0, 64)}" has no file name in a repository: its name starts with a letter, digit or underscore.`,
    )
  }

  return `${tool}${PROGRAM_EXTENSION}`
}

/** Every path an item's files go at, from the repository's root. */
export function itemPaths(shape: ItemShape): string[] {
  const ref: ItemRef = { kind: shape.kind, name: checkItemName(shape.name) }

  switch (shape.kind) {
    case "skill":
      return [SKILL_MD, ...shape.files].map((file) => itemPath(ref, file))
    case "wrapper":
    case "flow":
      return [WRAPPER_YAML, ...shape.tools.map(programFile)].map((file) =>
        itemPath(ref, file),
      )
    case "endpoint":
      return [shape.spec === "json" ? SPEC_JSON : SPEC_YAML, ENDPOINT_YAML].map(
        (file) => itemPath(ref, file),
      )
    case "server":
    case "service":
      return [itemRoot(ref)]
  }
}

/**
 * Refuses a set of items two of which would be at one path, or would be one
 * server in a vault: two wrappers, flows, endpoints or servers by one name,
 * or two names a case-insensitive file system holds as one.
 */
export function checkDistinct(refs: ItemRef[]): void {
  const servers = new Map<string, ItemRef>()
  const roots = new Map<string, ItemRef>()

  for (const ref of refs) {
    checkItemName(ref.name)
    const root = itemRoot(ref).toLowerCase()
    const before = roots.get(root)

    if (before) {
      throw invalid(
        `Two items go at ${itemRoot(ref)}: each needs a name of its own.`,
      )
    }

    roots.set(root, ref)

    if (isServerKind(ref.kind)) {
      const other = servers.get(ref.name)

      if (other) {
        throw invalid(
          `${itemRoot(other)} and ${itemRoot(ref)} have one name, ${ref.name}, and a vault has one server by a name: rename one.`,
        )
      }

      servers.set(ref.name, ref)
    }
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** Whether a file is an endpoint's OpenAPI document, which may be larger. */
function isSpecFile(ref: ItemRef, file: string): boolean {
  return ref.kind === "endpoint" && (file === SPEC_JSON || file === SPEC_YAML)
}

/** One item's files, as groupRepoFiles finds them. */
export type ItemFiles = {
  ref: ItemRef
  /** By the file's name inside the item (a server's: its one file). */
  files: Record<string, string>
}

/** A file of an item that could not be read as one, and why. */
export type RepoProblem = { path: string; message: string }

/**
 * A repository's files sorted into items, checked as a whole before any is
 * parsed. A path that leaves its folder, hides a character or clashes with
 * another but for case, two items at one place or with one server name, and
 * an item past its limits refuse the whole repository: it is not read at
 * all. A file whose name is no item's (a folder that is not a slug) is a
 * problem of its own, and the item it would be in is left out; files that
 * are no item's (a README) are left alone.
 */
export function groupRepoFiles(files: RepoFiles): {
  items: ItemFiles[]
  problems: RepoProblem[]
} {
  const items = new Map<string, ItemFiles>()
  const seen = new Map<string, string>()
  const problems: RepoProblem[] = []
  const broken = new Set<string>()

  for (const [path, text] of Object.entries(files)) {
    checkRepoPath(path)
    const lower = path.toLowerCase()
    const clash = seen.get(lower)

    if (clash !== undefined) {
      throw invalid(
        `${clash} and ${path} differ only in case, which some file systems hold as one file.`,
      )
    }

    seen.set(lower, path)

    if (typeof text !== "string") {
      throw invalid(`${path} is not text.`)
    }

    let found: ReturnType<typeof itemOfPath>

    try {
      found = itemOfPath(path)
    } catch (error) {
      problems.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      })
      broken.add(
        path
          .split("/")
          .slice(0, 2)
          .join("/")
          .replace(/\.yaml$/, ""),
      )
      continue
    }

    if (!found) {
      continue
    }

    const key = itemKey(found.ref)
    const item = items.get(key) ?? { ref: found.ref, files: {} }
    item.files[found.file] = text
    items.set(key, item)
  }

  const list = [...items.values()]
    .filter((item) => !broken.has(itemRoot(item.ref).replace(/\.yaml$/, "")))
    .sort((a, b) => itemRoot(a.ref).localeCompare(itemRoot(b.ref)))

  checkDistinct(list.map((item) => item.ref))

  for (const item of list) {
    checkItemSize(item)
  }

  return { items: list, problems }
}

/** An item's files within its limits: how many, and how large. */
export function checkItemSize(item: ItemFiles): void {
  const names = Object.keys(item.files)
  const root = itemRoot(item.ref)

  if (names.length > MAX_ITEM_FILES) {
    throw invalid(
      `${root} has ${names.length} files; an item has at most ${MAX_ITEM_FILES}.`,
    )
  }

  let total = 0

  for (const name of names) {
    const text = item.files[name]!
    const bytes = byteLength(text)
    const max = isSpecFile(item.ref, name)
      ? MAX_SPEC_FILE_BYTES
      : MAX_FILE_BYTES

    if (bytes > max) {
      throw invalid(
        `${itemPath(item.ref, name)} is ${bytes.toLocaleString("en")} bytes; a file there has at most ${max.toLocaleString("en")}.`,
      )
    }

    total += bytes
  }

  if (total > MAX_ITEM_BYTES) {
    throw invalid(
      `${root}'s files come to ${total.toLocaleString("en")} bytes; an item's have at most ${MAX_ITEM_BYTES.toLocaleString("en")}.`,
    )
  }
}
