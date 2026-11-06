import type { Readable } from "node:stream"

import { PcpError } from "../errors"
import type { SealedFile } from "./encrypted"
import {
  MAX_DELETE_ENTRIES,
  MAX_DEPTH,
  MAX_FIND_FOLDERS,
  MAX_LIST_ENTRIES,
  PART_SUFFIX,
} from "./limits"
import {
  isInside,
  isPartName,
  joinRelative,
  relativeTo,
  splitPath,
  under,
} from "./paths"
import {
  FileTooLargeError,
  partSuffix,
  SFTP_STATUS,
  sftpStatus,
  type EntryType,
  type RemoteFs,
  type RemoteStat,
} from "./sftp"

/**
 * A storage root's files, confined to it. Every path a call names is split
 * by paths.ts (no `..`), then resolved on the server: the folder it is in
 * by its real path, which must be the root's real path or inside it, so a
 * symbolic link anywhere on the way cannot lead out. What a path names is
 * looked at without following a link (lstat); reading a file, or a folder
 * to list or find in, follows one only when its real path is inside too.
 * Deleting or moving a link acts on the link itself, never on what it
 * points to.
 *
 * Writes are whole or nothing: a file is written under a part name
 * (`<name>.<random>.pcp-part`) with exclusive create, given its mode, and
 * renamed into place; SFTP's own rename fails when the name is taken, so a
 * file that appeared meanwhile is not replaced unless the call said
 * `overwrite`. New files and folders get their mode from the root's umask,
 * set by PCP after the server's own umask had its say.
 */

export type Entry = {
  name: string
  /** Relative to the root. */
  path: string
  type: EntryType
  size?: number
  modified: string
  /** A link: whether it points inside the root, outside, or nowhere. */
  points?: "inside" | "outside" | "nowhere"
}

export type Listing = {
  path: string
  entries: Entry[]
  /** More entries than PCP lists at once: the first ones, by name. */
  truncated?: boolean
}

export type Found = {
  path: string
  matches: Entry[]
  /** Why the search stopped before it looked everywhere. */
  stopped?: string
}

export type StorageFolder = {
  rootReal: string
  list(path: string, limit?: number): Promise<Listing>
  find(
    path: string,
    test: (name: string) => boolean,
    options: { type?: "file" | "folder"; limit: number },
  ): Promise<Found>
  /** A file's bytes, its name and size, at most `maxBytes`. */
  read(
    path: string,
    maxBytes: number,
  ): Promise<{ path: string; name: string; bytes: Buffer; modified: string }>
  /**
   * A file as a stream, whole or a range of it (`offset`, `length`), for a
   * download or a conversion: nothing is held but what is being read.
   */
  open(
    path: string,
    range?: { offset?: number; length?: number },
  ): Promise<OpenedFile>
  save(
    path: string,
    bytes: Buffer,
    options: { overwrite: boolean },
  ): Promise<{ path: string; size: number; replaced: boolean }>
  /**
   * The same from a stream, as it arrives; past `maxBytes` it stops,
   * keeps nothing of it and refuses (FileTooLargeError).
   */
  saveFrom(
    path: string,
    source: AsyncIterable<Buffer> | Iterable<Buffer>,
    options: { overwrite: boolean; maxBytes?: number },
  ): Promise<{ path: string; size: number; replaced: boolean }>
  makeFolder(
    path: string,
    options: { parents: boolean },
  ): Promise<{ path: string; existed: boolean }>
  move(
    from: string,
    to: string,
    options: { overwrite: boolean },
  ): Promise<{ from: string; to: string; replaced: boolean }>
  remove(
    path: string,
    options: { recursive: boolean },
  ): Promise<{ path: string; type: EntryType; removed: number }>
  /** Whether PCP can write here: a part file made and removed. */
  probeWrite(): Promise<void>
  /**
   * An encrypted store's file with its own key and where its object is
   * (encrypted.ts SealedFile), for what reads it with that key alone (a
   * public link); a plain folder has none.
   */
  sealed?(path: string): Promise<SealedFile>
}

export type OpenedFile = {
  path: string
  name: string
  /** The whole file's size. */
  size: number
  modified: string
  /** The range asked for, cut to the file. */
  offset: number
  length: number
  stream: Readable
}

/** The range asked of a file of `size` bytes, cut to it. */
export function clampRange(
  size: number,
  range: { offset?: number; length?: number } = {},
): { offset: number; length: number } {
  const offset = Math.min(size, Math.max(0, Math.floor(range.offset ?? 0)))
  const length = Math.min(
    size - offset,
    Math.max(0, Math.floor(range.length ?? size - offset)),
  )
  return { offset, length }
}

function iso(mtime: number): string {
  return new Date(mtime * 1000).toISOString()
}

function shown(path: string): string {
  return path === "" ? "the folder's top" : path
}

/** What an SFTP failure means for a call, in PCP's words. */
export function refusalFromSftp(error: unknown, what: string): never {
  if (error instanceof PcpError || error instanceof FileTooLargeError) {
    throw error
  }

  const status = sftpStatus(error)

  if (status === SFTP_STATUS.NO_SUCH_FILE) {
    throw new PcpError("not_found", `${what}: there is nothing there.`)
  }

  if (status === SFTP_STATUS.PERMISSION_DENIED) {
    throw new PcpError(
      "forbidden",
      `${what}: the server did not allow it (permission denied for PCP's login).`,
    )
  }

  throw error
}

/**
 * Opens a root: its real path, which must be a folder. `umask` decides the
 * mode of what PCP makes.
 */
export async function openFolder(
  fs: RemoteFs,
  rootPath: string,
  { umask }: { umask: number },
): Promise<StorageFolder> {
  let rootReal: string

  try {
    rootReal = await fs.realpath(rootPath)
    const top = await fs.stat(rootReal)

    if (top.type !== "folder") {
      throw new PcpError("state", `${rootPath} on the server is not a folder.`)
    }
  } catch (error) {
    if (sftpStatus(error) === SFTP_STATUS.NO_SUCH_FILE) {
      throw new PcpError(
        "state",
        `${rootPath} is not there on the server: the owner checks the folder on its page in PCP.`,
      )
    }

    refusalFromSftp(error, rootPath)
  }

  const fileMode = 0o666 & ~umask
  const folderMode = 0o777 & ~umask

  /** The real path of a folder the call names, which must be inside. */
  async function folderAt(names: string[], label: string): Promise<string> {
    let real: string

    try {
      real = await fs.realpath(under(rootReal, names))
    } catch (error) {
      refusalFromSftp(error, shown(label))
    }

    if (!isInside(rootReal, real)) {
      throw new PcpError(
        "forbidden",
        `${shown(label)} leads out of the folder (a link to somewhere else), so PCP does not follow it.`,
      )
    }

    let stat: RemoteStat

    try {
      stat = await fs.stat(real)
    } catch (error) {
      refusalFromSftp(error, shown(label))
    }

    if (stat.type !== "folder") {
      throw new PcpError("validation", `${shown(label)} is not a folder.`)
    }

    return real
  }

  /**
   * Where a name is: the real path of the folder it is in (checked), and
   * the entry's own path there, not followed.
   */
  async function place(raw: string) {
    const names = splitPath(raw)

    if (names.length === 0) {
      return { names, parent: rootReal, own: rootReal, leaf: "" }
    }

    const parentNames = names.slice(0, -1)
    const parent = await folderAt(parentNames, joinRelative(parentNames))
    const leaf = names[names.length - 1]!

    return { names, parent, own: under(parent, [leaf]), leaf }
  }

  /** The path relative to the root of something PCP placed. */
  function relative(real: string): string {
    return joinRelative(relativeTo(rootReal, real))
  }

  async function lstatOrNull(path: string): Promise<RemoteStat | null> {
    try {
      return await fs.lstat(path)
    } catch (error) {
      if (sftpStatus(error) === SFTP_STATUS.NO_SUCH_FILE) return null
      throw error
    }
  }

  /** Where a link points, from the root's side. */
  async function linkPoints(
    path: string,
  ): Promise<{ points: "inside" | "outside" | "nowhere"; real?: string }> {
    try {
      const real = await fs.realpath(path)
      return isInside(rootReal, real)
        ? { points: "inside", real }
        : { points: "outside" }
    } catch {
      return { points: "nowhere" }
    }
  }

  /** A folder the call names, following a link only into the root. */
  async function folderToRead(raw: string): Promise<{ real: string }> {
    const names = splitPath(raw)
    return { real: await folderAt(names, joinRelative(names)) }
  }

  async function entriesOf(real: string, max: number) {
    try {
      return await fs.readdir(real, max)
    } catch (error) {
      refusalFromSftp(error, shown(relative(real)))
    }
  }

  function entryOf(base: string, name: string, stat: RemoteStat): Entry {
    return {
      name,
      path: joinRelative([...splitPath(base), name]),
      type: stat.type,
      ...(stat.type === "file" ? { size: stat.size } : {}),
      modified: iso(stat.mtime),
    }
  }

  /** Writes under a part name next to `own` (`write`), then renames it. */
  async function writeInPlace(
    parent: string,
    own: string,
    leaf: string,
    write: (part: string, mode: number) => Promise<number>,
    overwrite: boolean,
  ): Promise<{ replaced: boolean; size: number }> {
    const before = await lstatOrNull(own).catch((error) =>
      refusalFromSftp(error, relative(own)),
    )

    if (before?.type === "folder") {
      throw new PcpError(
        "conflict",
        `${relative(own)} is a folder; a file cannot take its place.`,
      )
    }

    if (before && !overwrite) {
      throw new PcpError(
        "conflict",
        `${relative(own)} is there already. Pass overwrite: true to replace it, or choose another name.`,
      )
    }

    const part = under(parent, [`${leaf}${partSuffix()}${PART_SUFFIX}`])
    let size = 0

    try {
      size = await write(part, fileMode)
      // The server's own umask had its say on create: the root's wins.
      await fs.chmod(part, fileMode)

      if (overwrite && before) {
        await fs.replace(part, own)
      } else {
        try {
          await fs.rename(part, own)
        } catch (error) {
          // Taken in the meantime: SFTP's rename does not replace.
          if ((await lstatOrNull(own)) && !overwrite) {
            throw new PcpError(
              "conflict",
              `${relative(own)} appeared while PCP was writing it, so PCP left it as it is. Pass overwrite: true to replace it.`,
            )
          }

          if (overwrite) {
            await fs.replace(part, own)
          } else {
            throw error
          }
        }
      }
    } catch (error) {
      await fs.unlink(part).catch(() => {})
      refusalFromSftp(error, relative(own))
    }

    return { replaced: before !== null, size }
  }

  /** A file the call names, following a link only into the root. */
  async function fileAt(
    raw: string,
  ): Promise<{ real: string; name: string; size: number }> {
    const { own, leaf, names } = await place(raw)

    if (names.length === 0) {
      throw new PcpError("validation", "Name a file, not the folder itself.")
    }

    let stat: RemoteStat | null

    try {
      stat = await lstatOrNull(own)
    } catch (error) {
      refusalFromSftp(error, raw)
    }

    if (!stat) {
      throw new PcpError("not_found", `${joinRelative(names)} is not there.`)
    }

    let real = own

    if (stat.type === "link") {
      const link = await linkPoints(own)

      if (link.points !== "inside" || !link.real) {
        throw new PcpError(
          "forbidden",
          `${joinRelative(names)} is a link that leads ${link.points === "nowhere" ? "nowhere" : "out of the folder"}, so PCP does not follow it.`,
        )
      }

      real = link.real

      try {
        stat = await fs.stat(real)
      } catch (error) {
        refusalFromSftp(error, raw)
      }
    }

    if (stat.type !== "file") {
      throw new PcpError(
        "validation",
        `${joinRelative(names)} is ${stat.type === "folder" ? "a folder: list_folder lists it" : "not a file"}.`,
      )
    }

    return { real, name: leaf, size: stat.size }
  }

  const folder: StorageFolder = {
    rootReal,

    async list(raw, limit = MAX_LIST_ENTRIES) {
      const { real } = await folderToRead(raw)
      const { entries, more } = await entriesOf(
        real,
        Math.min(limit, MAX_LIST_ENTRIES),
      )
      const base = relative(real)
      const out: Entry[] = []

      for (const { name, stat } of entries) {
        const entry = entryOf(base, name, stat)

        if (stat.type === "link") {
          entry.points = (await linkPoints(under(real, [name]))).points
        }

        out.push(entry)
      }

      out.sort((a, b) =>
        a.type === "folder" && b.type !== "folder"
          ? -1
          : b.type === "folder" && a.type !== "folder"
            ? 1
            : a.name.localeCompare(b.name),
      )

      return { path: base, entries: out, ...(more ? { truncated: true } : {}) }
    },

    async find(raw, test, { type, limit }) {
      const { real } = await folderToRead(raw)
      const matches: Entry[] = []
      const queue: Array<{ real: string; depth: number }> = [{ real, depth: 0 }]
      let folders = 0
      let stopped: string | undefined

      while (queue.length > 0) {
        const next = queue.shift()!

        if (++folders > MAX_FIND_FOLDERS) {
          stopped = `It looked in ${MAX_FIND_FOLDERS} folders and stopped: name a folder further down as path.`
          break
        }

        let listed: Awaited<ReturnType<RemoteFs["readdir"]>>

        try {
          listed = await fs.readdir(next.real, MAX_LIST_ENTRIES * 10)
        } catch (error) {
          // A folder PCP's login cannot read is passed over.
          if (sftpStatus(error) === SFTP_STATUS.PERMISSION_DENIED) continue
          refusalFromSftp(error, shown(relative(next.real)))
        }

        const base = relative(next.real)

        for (const { name, stat } of listed.entries) {
          if (
            test(name) &&
            (!type || stat.type === type) &&
            !isPartName(name)
          ) {
            matches.push(entryOf(base, name, stat))

            if (matches.length >= limit) {
              stopped = `It found ${limit} and stopped: raise limit or narrow the pattern.`
              break
            }
          }

          // Links are never followed: a folder is looked in only once.
          if (stat.type === "folder" && next.depth < MAX_DEPTH) {
            queue.push({
              real: under(next.real, [name]),
              depth: next.depth + 1,
            })
          }
        }

        if (stopped) break
      }

      matches.sort((a, b) => a.path.localeCompare(b.path))
      return {
        path: relative(real),
        matches,
        ...(stopped ? { stopped } : {}),
      }
    },

    async read(raw, maxBytes) {
      const found = await fileAt(raw)

      if (found.size > maxBytes) {
        throw new FileTooLargeError(found.size)
      }

      let bytes: Buffer
      let modified: string

      try {
        bytes = await fs.readFile(found.real, maxBytes)
        modified = iso((await fs.stat(found.real)).mtime)
      } catch (error) {
        refusalFromSftp(error, raw)
      }

      return {
        path: joinRelative(splitPath(raw)),
        name: found.name,
        bytes,
        modified,
      }
    },

    save(raw, bytes, { overwrite }) {
      return folder.saveFrom(raw, [bytes], { overwrite })
    },

    async open(raw, range) {
      const found = await fileAt(raw)
      const { offset, length } = clampRange(found.size, range)
      let modified: string

      try {
        modified = iso((await fs.stat(found.real)).mtime)
      } catch (error) {
        refusalFromSftp(error, raw)
      }

      return {
        path: joinRelative(splitPath(raw)),
        name: found.name,
        size: found.size,
        modified,
        offset,
        length,
        stream: fs.readStream(found.real, {
          start: offset,
          end: offset + length,
        }),
      }
    },

    async saveFrom(raw, source, { overwrite, maxBytes }) {
      const { names, parent, own, leaf } = await place(raw)

      if (names.length === 0) {
        throw new PcpError(
          "validation",
          "Name the file to save, not the folder.",
        )
      }

      if (isPartName(leaf)) {
        throw new PcpError(
          "validation",
          `A name ending in ${PART_SUFFIX} is PCP's own, for a file it is still writing.`,
        )
      }

      const { replaced, size } = await writeInPlace(
        parent,
        own,
        leaf,
        (part, mode) => fs.writeNewFrom(part, source, mode, maxBytes),
        overwrite,
      )
      return { path: relative(own), size, replaced }
    },

    async makeFolder(raw, { parents }) {
      const names = splitPath(raw)

      if (names.length === 0) {
        return { path: "", existed: true }
      }

      let at = rootReal
      let existed = true

      for (let index = 0; index < names.length; index++) {
        const name = names[index]!
        const last = index === names.length - 1
        const path = under(at, [name])
        const stat = await lstatOrNull(path).catch((error) =>
          refusalFromSftp(error, joinRelative(names.slice(0, index + 1))),
        )

        if (!stat) {
          if (!last && !parents) {
            throw new PcpError(
              "not_found",
              `${joinRelative(names.slice(0, index + 1))} is not there. Pass parents: true to make it too.`,
            )
          }

          if (isPartName(name)) {
            throw new PcpError(
              "validation",
              `A name ending in ${PART_SUFFIX} is PCP's own.`,
            )
          }

          try {
            await fs.mkdir(path, folderMode)
            await fs.chmod(path, folderMode)
          } catch (error) {
            refusalFromSftp(error, joinRelative(names.slice(0, index + 1)))
          }

          existed = false
          at = path
          continue
        }

        // Through a link only into the root, as everywhere.
        at = await folderAt(
          names.slice(0, index + 1),
          joinRelative(names.slice(0, index + 1)),
        )

        if (last && stat.type !== "folder" && stat.type !== "link") {
          throw new PcpError(
            "conflict",
            `${joinRelative(names)} is there already, and is not a folder.`,
          )
        }
      }

      return { path: relative(at), existed }
    },

    async move(fromRaw, toRaw, { overwrite }) {
      const from = await place(fromRaw)
      const to = await place(toRaw)

      if (from.names.length === 0 || to.names.length === 0) {
        throw new PcpError(
          "validation",
          "The folder itself cannot be moved, or be moved onto.",
        )
      }

      if (isPartName(to.leaf)) {
        throw new PcpError(
          "validation",
          `A name ending in ${PART_SUFFIX} is PCP's own.`,
        )
      }

      const source = await lstatOrNull(from.own).catch((error) =>
        refusalFromSftp(error, fromRaw),
      )

      if (!source) {
        throw new PcpError(
          "not_found",
          `${joinRelative(from.names)} is not there.`,
        )
      }

      if (
        source.type === "folder" &&
        (to.own === from.own || to.own.startsWith(`${from.own}/`))
      ) {
        throw new PcpError(
          "validation",
          "A folder cannot be moved into itself.",
        )
      }

      if (to.own === from.own) {
        return {
          from: relative(from.own),
          to: relative(to.own),
          replaced: false,
        }
      }

      const target = await lstatOrNull(to.own).catch((error) =>
        refusalFromSftp(error, toRaw),
      )

      if (target && (!overwrite || target.type === "folder")) {
        throw new PcpError(
          "conflict",
          target.type === "folder"
            ? `${joinRelative(to.names)} is a folder: name the new path in full, inside it (${joinRelative([...to.names, from.leaf])}).`
            : `${joinRelative(to.names)} is there already. Pass overwrite: true to replace it.`,
        )
      }

      try {
        if (target) {
          await fs.replace(from.own, to.own)
        } else {
          await fs.rename(from.own, to.own)
        }
      } catch (error) {
        refusalFromSftp(error, joinRelative(from.names))
      }

      return {
        from: relative(from.own),
        to: relative(to.own),
        replaced: target !== null,
      }
    },

    async remove(raw, { recursive }) {
      const { names, own } = await place(raw)

      if (names.length === 0) {
        throw new PcpError(
          "validation",
          "The folder itself cannot be deleted here; the owner removes it on the server.",
        )
      }

      const stat = await lstatOrNull(own).catch((error) =>
        refusalFromSftp(error, raw),
      )

      if (!stat) {
        throw new PcpError("not_found", `${joinRelative(names)} is not there.`)
      }

      try {
        if (stat.type !== "folder") {
          // A link goes itself; what it points to stays.
          await fs.unlink(own)
          return { path: relative(own), type: stat.type, removed: 1 }
        }

        const inside = await fs.readdir(own, 1)

        if (inside.entries.length > 0 && !recursive) {
          throw new PcpError(
            "conflict",
            `${joinRelative(names)} is not empty. Pass recursive: true to delete it with everything in it.`,
          )
        }

        const removed = await removeTree(fs, own)
        return { path: relative(own), type: "folder", removed }
      } catch (error) {
        refusalFromSftp(error, joinRelative(names))
      }
    },

    async probeWrite() {
      const part = under(rootReal, [`.pcp-check${partSuffix()}${PART_SUFFIX}`])

      try {
        await fs.writeNew(part, Buffer.alloc(0), fileMode)
      } catch (error) {
        refusalFromSftp(error, "Writing in the folder")
      }

      await fs.unlink(part).catch(() => {})
    },
  }

  return folder
}

/**
 * Removes a folder and what is in it, deepest first, never following a
 * link (a link inside is removed as a link). Stops past MAX_DELETE_ENTRIES
 * or MAX_DEPTH with what it removed so far said.
 */
async function removeTree(fs: RemoteFs, top: string): Promise<number> {
  let removed = 0

  async function walk(path: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      throw new PcpError(
        "state",
        `The folder goes deeper than ${MAX_DEPTH} levels; PCP stopped after deleting ${removed} entries. Delete a folder further down first.`,
      )
    }

    for (;;) {
      const { entries } = await fs.readdir(path, 256)

      if (entries.length === 0) break

      for (const { name, stat } of entries) {
        if (removed >= MAX_DELETE_ENTRIES) {
          throw new PcpError(
            "state",
            `PCP deletes at most ${MAX_DELETE_ENTRIES} entries in one call and stopped there. Call delete again to go on.`,
          )
        }

        const child = under(path, [name])

        if (stat.type === "folder") {
          await walk(child, depth + 1)
        } else {
          await fs.unlink(child)
          removed++
        }
      }
    }

    await fs.rmdir(path)
    removed++
  }

  await walk(top, 0)
  return removed
}
