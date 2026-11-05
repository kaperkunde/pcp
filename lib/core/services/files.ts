import { invalid } from "../errors"
import { pathWithin, trimPath, type ServiceFiles } from "./definition"
import { MAX_FILE_NAME_CHARS, MAX_FILE_NAME_PART_CHARS } from "./limits"

/**
 * A service's files folder (`files` in its definition): the names PCP puts
 * a file at or gets one from, confined to that folder by their words, and
 * the tar stream the engine's `cp` takes on standard input and writes on
 * standard output (engine.ts copyIntoContainer, copyOutOfContainer). Pure:
 * nothing here connects, and no name here ever reaches a shell unquoted.
 *
 * A name is relative to the folder (`in/report.pdf`), or the full path in
 * the container inside it (`/data/in/report.pdf`, as the service's own
 * tools name it): folders and names of letters, digits, spaces and
 * `._@+,=()-`, never `.` or `..`, an empty part or a leading or trailing
 * space. The engine resolves the path inside the container's own
 * filesystem, never the SSH server's.
 */

const PART =
  /^[A-Za-z0-9._@+,=()-](?:[A-Za-z0-9._@+,=() -]*[A-Za-z0-9._@+,=()-])?$/

export type FileName = {
  /** Relative to the files folder: what goes in the tar stream. */
  relative: string
  /** The full path in the container: what the service's tools take. */
  path: string
}

/** The files folder as one path, without a trailing slash. */
export function filesFolder(files: ServiceFiles): string {
  return trimPath(files.path)
}

/**
 * A name in the files folder, checked: relative to it, or a full path in
 * the container inside it. Throws `invalid` with what is wrong.
 */
export function fileName(files: ServiceFiles, given: string): FileName {
  const folder = filesFolder(files)
  let relative = given

  if (given.startsWith("/")) {
    if (!pathWithin(given, folder) || trimPath(given) === folder) {
      throw invalid(
        `${given} is not a file in the service's files folder, ${folder}: name one inside it, or a name relative to it.`,
      )
    }

    relative = given.slice(folder === "/" ? 1 : folder.length + 1)
  }

  if (relative.length === 0 || relative.length > MAX_FILE_NAME_CHARS) {
    throw invalid(
      `A file's name in the files folder is 1 to ${MAX_FILE_NAME_CHARS} characters.`,
    )
  }

  for (const part of relative.split("/")) {
    if (part === "." || part === "..") {
      throw invalid(
        "A file's name stays in the files folder: no . or .. in it.",
      )
    }

    if (part.length === 0) {
      throw invalid(
        "A file's name has no empty part: no // in it, and no / at its end.",
      )
    }

    if (part.length > MAX_FILE_NAME_PART_CHARS) {
      throw invalid(
        `Each folder and name in a file's name is at most ${MAX_FILE_NAME_PART_CHARS} characters.`,
      )
    }

    if (!PART.test(part)) {
      throw invalid(
        `${JSON.stringify(part)} is not a name PCP puts in a service's files folder: letters, digits, spaces and ._@+,=()- only, with no space at its start or end.`,
      )
    }
  }

  return {
    relative,
    path: `${folder === "/" ? "" : folder}/${relative}`,
  }
}

// ---- tar ---------------------------------------------------------------------

const BLOCK = 512

function field(header: Buffer, offset: number, length: number, value: string) {
  header.write(value, offset, length, "ascii")
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`
}

/** Splits a name into ustar's prefix and name, or null when it cannot be. */
function ustarName(name: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(name) <= 100) {
    return { prefix: "", name }
  }

  for (let at = name.indexOf("/"); at !== -1; at = name.indexOf("/", at + 1)) {
    const prefix = name.slice(0, at)
    const rest = name.slice(at + 1)

    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) {
      return { prefix, name: rest }
    }
  }

  return null
}

/**
 * A tar stream of one regular file: the name (checked by fileName), mode
 * 0644, owner 0:0 (the engine sets the owner as it copies: Docker's root,
 * Podman's container user) and no folders of its own, so a folder that is
 * there keeps its owner and mode, and one that is not is made by the engine.
 */
export function fileTar(
  name: string,
  bytes: Buffer,
  mtime = new Date(),
): Buffer {
  const split = ustarName(name)

  if (!split) {
    throw invalid(
      "That name is too long for a tar stream: keep the last part shorter, or use fewer folders.",
    )
  }

  const header = Buffer.alloc(BLOCK, 0)
  field(header, 0, 100, split.name)
  field(header, 100, 8, octal(0o644, 8))
  field(header, 108, 8, octal(0, 8))
  field(header, 116, 8, octal(0, 8))
  field(header, 124, 12, octal(bytes.length, 12))
  field(header, 136, 12, octal(Math.floor(mtime.getTime() / 1000), 12))
  field(header, 148, 8, "        ")
  field(header, 156, 1, "0")
  field(header, 257, 6, "ustar\0")
  field(header, 263, 2, "00")
  field(header, 345, 155, split.prefix)

  let sum = 0
  for (const byte of header) sum += byte
  field(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)

  const padding = (BLOCK - (bytes.length % BLOCK)) % BLOCK
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc(padding, 0),
    Buffer.alloc(BLOCK * 2, 0),
  ])
}

export type TarEntryType = "file" | "folder" | "link" | "other"

export type TarEntry = {
  name: string
  type: TarEntryType
  size: number
  /** The file's bytes, when the stream held all of them. */
  data: Buffer | null
}

function cString(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? length : end).toString("utf8")
}

function number(header: Buffer, offset: number, length: number): number {
  const slice = header.subarray(offset, offset + length)

  // GNU's base-256, for a size past what octal holds.
  if (slice[0]! & 0x80) {
    let value = slice[0]! & 0x7f
    for (const byte of slice.subarray(1)) value = value * 256 + byte
    return value
  }

  const text = cString(header, offset, length).trim()
  const value = text ? parseInt(text, 8) : 0

  if (!/^[0-7]*$/.test(text) || !Number.isSafeInteger(value)) {
    throw new TarError("A tar header's number did not read.")
  }

  return value
}

function checksumFits(header: Buffer): boolean {
  let sum = 0
  for (let at = 0; at < BLOCK; at += 1) {
    sum += at >= 148 && at < 156 ? 0x20 : header[at]!
  }
  return sum === number(header, 148, 8)
}

/** pax records: `<length> key=value\n`, each. */
function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {}
  let at = 0

  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    const length = Number(data.subarray(at, space).toString("ascii"))

    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) {
      break
    }

    const record = data.subarray(space + 1, at + length - 1).toString("utf8")
    const equals = record.indexOf("=")
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    at += length
  }

  return records
}

/** The tar stream did not read as one. */
export class TarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TarError"
  }
}

const TYPES: Record<string, TarEntryType> = {
  "0": "file",
  "\0": "file",
  "7": "file",
  "5": "folder",
  "1": "link",
  "2": "link",
}

/**
 * The first entry of a tar stream (what `cp <container>:<path> -` writes
 * for one path), past pax and GNU long-name headers. Null for an empty
 * stream. `data` is the file's bytes when the stream holds all of them,
 * so a probe that read only the start still says what the name is.
 */
export function firstTarEntry(stream: Buffer): TarEntry | null {
  let at = 0
  let pax: Record<string, string> = {}
  let longName: string | null = null

  while (at + BLOCK <= stream.length) {
    const header = stream.subarray(at, at + BLOCK)

    if (header.every((byte) => byte === 0)) {
      return null
    }

    if (!checksumFits(header)) {
      throw new TarError("A tar header's checksum did not match.")
    }

    const flag = String.fromCharCode(header[156]!)
    const size = number(header, 124, 12)
    const dataAt = at + BLOCK
    const next = dataAt + Math.ceil(size / BLOCK) * BLOCK

    if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
      if (dataAt + size > stream.length) {
        throw new TarError("The tar stream ended inside a header.")
      }

      const data = stream.subarray(dataAt, dataAt + size)

      if (flag === "x") pax = paxRecords(data)
      if (flag === "L") longName = cString(data, 0, data.length)
      at = next
      continue
    }

    const prefix = cString(header, 345, 155)
    const own = cString(header, 0, 100)
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${own}` : own)
    const fullSize = pax.size !== undefined ? Number(pax.size) : size

    if (!Number.isSafeInteger(fullSize) || fullSize < 0) {
      throw new TarError("A tar entry's size did not read.")
    }

    const type = TYPES[flag] ?? "other"
    const whole = dataAt + fullSize <= stream.length

    return {
      name,
      type,
      size: type === "file" ? fullSize : 0,
      data:
        type === "file" && whole
          ? Buffer.from(stream.subarray(dataAt, dataAt + fullSize))
          : null,
    }
  }

  if (at === 0 && stream.length === 0) {
    return null
  }

  throw new TarError("The tar stream ended inside a header.")
}
