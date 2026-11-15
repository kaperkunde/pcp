import { Readable } from "node:stream"

import type { StorageEntry } from "@/lib/generated/prisma/client"

import type { VaultContext } from "../context"
import { asBytes, decryptString, encryptString } from "../crypto"
import { db } from "../db"
import { PcpError } from "../errors"
import { newId } from "../ids"
import {
  decryptStream,
  encryptStream,
  nameKeyOf,
  newKey,
  newObjectId,
  OBJECT_ID,
  sealedRange,
  sealedSize,
  unwrapFileKey,
  wrapFileKey,
} from "./crypt"
import {
  clampRange,
  type Entry,
  type Found,
  type Listing,
  type OpenedFile,
  type StorageFolder,
} from "./files"
import {
  MAX_DELETE_ENTRIES,
  MAX_DEPTH,
  MAX_FIND_FOLDERS,
  MAX_LIST_ENTRIES,
  OBJECTS_FOLDER,
  PART_SUFFIX,
  PENDING_SWEEP_AGE_MS,
  PENDING_SWEEP_BATCH,
  LET_GO_ROUNDS,
} from "./limits"
import { joinRelative, splitPath, under } from "./paths"
import {
  FileTooLargeError,
  partSuffix,
  SFTP_STATUS,
  sftpStatus,
  type RemoteFs,
} from "./sftp"

/**
 * An encrypted store's files (lib/core/storage/): what assistants and the
 * owner see is the index, `storage_entry`, one row per file or folder with
 * its name, size, type and times encrypted under the vault key; what is on
 * the backend (the SSH server's folder, or PCP's data folder) is opaque
 * objects under `.pcp-store/<two hex>/<object id>`, each sealed under a key
 * of its own (crypt.ts), which the store key wraps. Nothing on the backend
 * names a file, a folder or how they nest.
 *
 * Paths are the same as a plain store's (paths.ts: `..` refused, names
 * split on `/`), resolved in the index, so there is nothing to follow out.
 * A write seals the file into a new object under a part name, renames it
 * into place and only then points the index at it, in one transaction that
 * also lets go of the object it replaced; until that, the object is in
 * `storage_pending`, which a later request (or the cleanup, for the local
 * store) sweeps if the write never finished. So a file is whole or not
 * there, as in a plain folder.
 */

/** What an entry's meta holds, encrypted. */
type Meta = {
  /** The name. */
  n: string
  /** Size in bytes (a file). */
  s?: number
  /** Media type, when one was given. */
  t?: string
  /** Modified, ISO. */
  m: string
}

export type EncryptedStore = {
  serverId: string
  /** The store key, unwrapped for this request. */
  storeKey: Buffer
  /** The store's real folder on its backend. */
  rootReal: string
  /** The umask of what PCP makes there. */
  umask: number
  /**
   * How many more sealed bytes the store may take, or null for no bound
   * (the local store's quota; an SSH server's folder has the server's own).
   */
  room?: () => Promise<number | null>
}

export function metaAad(id: string): string {
  return `storage_entry:${id}`
}

export function sealMeta(ctx: VaultContext, id: string, meta: Meta): Buffer {
  return encryptString(ctx.dek, JSON.stringify(meta), metaAad(id))
}

export function openMeta(
  ctx: VaultContext,
  entry: Pick<StorageEntry, "id" | "meta">,
): Meta {
  const value = JSON.parse(
    decryptString(ctx.dek, Buffer.from(entry.meta), metaAad(entry.id)),
  ) as Meta

  if (typeof value?.n !== "string" || typeof value.m !== "string") {
    throw new PcpError("state", "An entry of the store's index is damaged.")
  }

  return value
}

/** Where an object is under the store's folder. */
export function objectPath(rootReal: string, objectId: string): string {
  if (!OBJECT_ID.test(objectId)) {
    throw new PcpError("state", "An object id is not PCP's.")
  }

  return under(rootReal, [OBJECTS_FOLDER, objectId.slice(0, 2), objectId])
}

function isUniqueClash(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002"
}

/** Makes a folder on the backend when it is not there. */
async function ensureDir(fs: RemoteFs, path: string, mode: number) {
  try {
    await fs.mkdir(path, mode)
  } catch (error) {
    const there = await fs.lstat(path).catch(() => null)
    if (there?.type !== "folder") throw error
  }
}

/**
 * Removes the objects let go of (written again, deleted, a write that never
 * finished): those `storage_pending` holds longer than the sweep's age, or
 * at once with `all`. Each goes with its part files, then its row.
 */
export async function sweepPending(
  store: Pick<EncryptedStore, "serverId" | "rootReal">,
  fs: RemoteFs,
  { now = Date.now(), all = false }: { now?: number; all?: boolean } = {},
): Promise<number> {
  const rows = await db().storagePending.findMany({
    where: {
      serverId: store.serverId,
      ...(all
        ? {}
        : { createdAt: { lt: new Date(now - PENDING_SWEEP_AGE_MS) } }),
    },
    orderBy: { createdAt: "asc" },
    take: PENDING_SWEEP_BATCH,
  })
  let removed = 0

  for (const row of rows) {
    if (OBJECT_ID.test(row.objectId)) {
      const path = objectPath(store.rootReal, row.objectId)
      const dir = path.slice(0, path.lastIndexOf("/"))

      await fs.unlink(path).catch((error) => {
        if (sftpStatus(error) !== SFTP_STATUS.NO_SUCH_FILE) throw error
      })

      const listed = await fs.readdir(dir, 4096).catch(() => null)

      for (const { name } of listed?.entries ?? []) {
        if (name.startsWith(`${row.objectId}.`) && name.endsWith(PART_SUFFIX)) {
          await fs.unlink(under(dir, [name])).catch(() => {})
        }
      }
    }

    await db().storagePending.deleteMany({ where: { objectId: row.objectId } })
    removed++
  }

  return removed
}

/** An object written and sealed, not in the index yet. */
export type WrittenObject = {
  objectId: string
  fileKey: Buffer
  size: number
  storedBytes: number
}

/**
 * Seals a file into a new object as it streams in: under a part name, then
 * renamed into place. The object is in `storage_pending` until an entry
 * takes it (`commitFile`); a failure removes what was written.
 */
export async function writeObject(
  store: EncryptedStore,
  fs: RemoteFs,
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
  { maxBytes }: { maxBytes?: number } = {},
): Promise<WrittenObject> {
  const objectId = newObjectId()
  const fileKey = newKey()
  const path = objectPath(store.rootReal, objectId)
  const dir = path.slice(0, path.lastIndexOf("/"))
  const part = `${path}${partSuffix()}${PART_SUFFIX}`
  const room = store.room ? await store.room() : null
  const folderMode = 0o777 & ~store.umask
  const fileMode = 0o666 & ~store.umask

  if (room !== null && room <= 0) {
    throw new PcpError(
      "state",
      "The store is full: delete files, or the owner raises its size in PCP's settings, under Resources.",
    )
  }

  await db().storagePending.create({
    data: { objectId, serverId: store.serverId },
  })

  const plainLimit =
    maxBytes === undefined ? Number.POSITIVE_INFINITY : maxBytes
  let plainBytes = 0

  try {
    await ensureDir(fs, under(store.rootReal, [OBJECTS_FOLDER]), folderMode)
    await ensureDir(fs, dir, folderMode)

    const plain = Readable.from(
      (async function* () {
        for await (const chunk of source) {
          plainBytes += chunk.length
          if (plainBytes > plainLimit) throw new FileTooLargeError(plainBytes)
          yield chunk
        }
      })(),
    )
    const sealed = plain.pipe(encryptStream(fileKey, objectId))
    plain.on("error", (error) => sealed.destroy(error))

    const written = await fs.writeNewFrom(
      part,
      sealed,
      fileMode,
      room === null ? undefined : room,
    )
    await fs.rename(part, path)

    if (written !== sealedSize(plainBytes)) {
      throw new PcpError("state", "The stored file came out the wrong size.")
    }

    return {
      objectId,
      fileKey,
      size: plainBytes,
      storedBytes: written,
    }
  } catch (error) {
    await fs.unlink(part).catch(() => {})
    await fs.unlink(path).catch(() => {})
    await db()
      .storagePending.deleteMany({ where: { objectId } })
      .catch(() => {})

    // Past the room the store has left, not past the largest file.
    if (
      error instanceof FileTooLargeError &&
      room !== null &&
      plainBytes <= plainLimit
    ) {
      throw new PcpError(
        "state",
        "The store has no room for that file: delete files, or the owner raises its size in PCP's settings, under Resources.",
      )
    }
    throw error
  }
}

/** The file of an index entry as a stream, whole or a range. */
export function readObject(
  store: Pick<EncryptedStore, "serverId" | "storeKey" | "rootReal">,
  fs: RemoteFs,
  entry: Pick<StorageEntry, "objectId" | "fileKey">,
  size: number,
  { offset, length }: { offset: number; length: number },
): Readable {
  if (!entry.fileKey) {
    throw new PcpError("state", "A file of the store's index has no key.")
  }

  const fileKey = unwrapFileKey(
    store.storeKey,
    store.serverId,
    entry.objectId,
    entry.fileKey,
  )
  return openSealedObject(fs, store.rootReal, entry.objectId, fileKey, size, {
    offset,
    length,
  })
}

/**
 * One object opened with its file key alone, whole or a range: what a
 * holder of that one key reads (a public link to one file, whose key the
 * link wraps), with no store key or vault key.
 */
export function openSealedObject(
  fs: RemoteFs,
  rootReal: string,
  objectId: string,
  fileKey: Buffer,
  size: number,
  { offset, length }: { offset: number; length: number },
): Readable {
  const range = sealedRange(size, offset, length)
  const raw = fs.readStream(objectPath(rootReal, objectId), {
    start: range.start,
    end: range.end,
  })
  const plain = decryptStream(fileKey, objectId, { size, offset, length })
  raw.on("error", (error) => plain.destroy(error))
  return raw.pipe(plain)
}

/** One file of an encrypted store with its own key, for one request. */
export type SealedFile = {
  path: string
  name: string
  size: number
  modified: string
  objectId: string
  /** The file's key, unwrapped: wrap it again before keeping it anywhere. */
  fileKey: Buffer
  /** The store's real folder on its backend, where the object is. */
  rootReal: string
}

/**
 * The index and objects of one encrypted store as a StorageFolder, the
 * same calls a plain folder answers (files.ts), so the tools, the owner's
 * file browser and a conversion use either alike.
 */
export async function openEncryptedFolder(
  ctx: VaultContext,
  store: EncryptedStore,
  fs: RemoteFs,
): Promise<StorageFolder> {
  const { serverId } = store
  const key = (parentId: string, name: string) =>
    nameKeyOf(store.storeKey, parentId, name)

  // What earlier requests let go of, or never finished.
  await sweepPending(store, fs).catch((error) => {
    console.error("[storage] could not sweep old objects", error)
  })

  async function child(parentId: string, name: string) {
    return db().storageEntry.findUnique({
      where: {
        serverId_parentId_nameKey: {
          serverId,
          parentId,
          nameKey: key(parentId, name),
        },
      },
    })
  }

  /** The folder at `names`, its id ("" for the top). */
  async function folderAt(names: string[]): Promise<string> {
    let id = ""

    for (let index = 0; index < names.length; index++) {
      const found = await child(id, names[index]!)
      const label = joinRelative(names.slice(0, index + 1))

      if (!found) {
        throw new PcpError("not_found", `${label} is not there.`)
      }
      if (!found.folder) {
        throw new PcpError("validation", `${label} is not a folder.`)
      }
      id = found.id
    }

    return id
  }

  /** Where a name is: its folder's id and its own entry, if any. */
  async function place(raw: string) {
    const names = splitPath(raw)

    if (names.length === 0) {
      return { names, parentId: "", leaf: "", entry: null }
    }

    const parentId = await folderAt(names.slice(0, -1))
    const leaf = names[names.length - 1]!
    return { names, parentId, leaf, entry: await child(parentId, leaf) }
  }

  function entryOf(base: string, row: StorageEntry): Entry {
    const meta = openMeta(ctx, row)
    return {
      name: meta.n,
      path: joinRelative([...splitPath(base), meta.n]),
      type: row.folder ? "folder" : "file",
      ...(row.folder ? {} : { size: meta.s ?? 0 }),
      modified: meta.m,
    }
  }

  async function fileEntry(raw: string) {
    const { names, entry } = await place(raw)

    if (names.length === 0) {
      throw new PcpError("validation", "Name a file, not the store itself.")
    }
    if (!entry) {
      throw new PcpError("not_found", `${joinRelative(names)} is not there.`)
    }
    if (entry.folder) {
      throw new PcpError(
        "validation",
        `${joinRelative(names)} is a folder: list_folder lists it.`,
      )
    }

    return { names, entry, meta: openMeta(ctx, entry) }
  }

  /**
   * Removes the objects let go of (pending, dated long ago), a few batches
   * at once; what is left goes with a later request.
   */
  async function letGo() {
    for (let round = 0; round < LET_GO_ROUNDS; round++) {
      const removed = await sweepPending(store, fs).catch(() => 0)
      if (removed < PENDING_SWEEP_BATCH) break
    }
  }

  /**
   * Points the index at a written object: a new entry, or (overwrite) the
   * entry there, whose old object is let go of. In one transaction.
   */
  async function commit(
    parentId: string,
    name: string,
    object: WrittenObject,
    { overwrite, type }: { overwrite: boolean; type?: string },
  ): Promise<{ replaced: boolean }> {
    const meta: Meta = {
      n: name,
      s: object.size,
      ...(type ? { t: type } : {}),
      m: new Date().toISOString(),
    }
    const wrapped = asBytes(
      wrapFileKey(store.storeKey, serverId, object.objectId, object.fileKey),
    )
    let old: string | null = null

    try {
      await db().$transaction(async (tx) => {
        const there = await tx.storageEntry.findUnique({
          where: {
            serverId_parentId_nameKey: {
              serverId,
              parentId,
              nameKey: key(parentId, name),
            },
          },
        })

        if (there?.folder) {
          throw new PcpError(
            "conflict",
            `${name} is a folder; a file cannot take its place.`,
          )
        }

        if (there && !overwrite) {
          throw new PcpError(
            "conflict",
            `${name} is there already. Pass overwrite: true to replace it, or choose another name.`,
          )
        }

        if (there) {
          old = there.objectId
          await tx.storageEntry.update({
            where: { id: there.id },
            data: {
              objectId: object.objectId,
              fileKey: wrapped,
              meta: asBytes(sealMeta(ctx, there.id, meta)),
              storedBytes: object.storedBytes,
            },
          })
          // Let go of the old object: swept at once below, or later.
          await tx.storagePending.create({
            data: {
              objectId: there.objectId,
              serverId,
              createdAt: new Date(0),
            },
          })
        } else {
          const id = newId()
          await tx.storageEntry.create({
            data: {
              id,
              serverId,
              parentId,
              nameKey: key(parentId, name),
              objectId: object.objectId,
              fileKey: wrapped,
              meta: asBytes(sealMeta(ctx, id, meta)),
              storedBytes: object.storedBytes,
            },
          })
        }

        await tx.storagePending.deleteMany({
          where: { objectId: object.objectId },
        })
      })
    } catch (error) {
      // The object no entry took goes at once.
      await db()
        .storagePending.updateMany({
          where: { objectId: object.objectId },
          data: { createdAt: new Date(0) },
        })
        .catch(() => {})
      await letGo()

      if (isUniqueClash(error)) {
        throw new PcpError(
          "conflict",
          `${name} appeared while PCP was writing it, so PCP left it as it is. Pass overwrite: true to replace it.`,
        )
      }
      throw error
    }

    if (old) await letGo()
    return { replaced: old !== null }
  }

  async function children(parentId: string, take?: number) {
    return db().storageEntry.findMany({
      where: { serverId, parentId },
      ...(take ? { take } : {}),
    })
  }

  /** Every entry under a folder, deepest first, within the bounds. */
  async function descendants(id: string): Promise<StorageEntry[]> {
    const found: StorageEntry[] = []
    const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }]

    while (queue.length > 0) {
      const next = queue.shift()!

      if (next.depth > MAX_DEPTH) {
        throw new PcpError(
          "state",
          `The folder goes deeper than ${MAX_DEPTH} levels; delete a folder further down first.`,
        )
      }

      for (const row of await children(next.id)) {
        found.push(row)

        if (found.length > MAX_DELETE_ENTRIES) {
          throw new PcpError(
            "state",
            `PCP deletes at most ${MAX_DELETE_ENTRIES} entries in one call: delete a folder further down first.`,
          )
        }
        if (row.folder) queue.push({ id: row.id, depth: next.depth + 1 })
      }
    }

    return found.reverse()
  }

  const folder: StorageFolder = {
    rootReal: store.rootReal,

    async list(raw, limit = MAX_LIST_ENTRIES) {
      const names = splitPath(raw)
      const id = await folderAt(names)
      const base = joinRelative(names)
      const max = Math.min(limit, MAX_LIST_ENTRIES)
      const rows = await children(id)
      const entries = rows.map((row) => entryOf(base, row))

      entries.sort((a, b) =>
        a.type === "folder" && b.type !== "folder"
          ? -1
          : b.type === "folder" && a.type !== "folder"
            ? 1
            : a.name.localeCompare(b.name),
      )

      const listing: Listing = { path: base, entries: entries.slice(0, max) }
      if (entries.length > max) listing.truncated = true
      return listing
    },

    async find(raw, test, { type, limit }) {
      const names = splitPath(raw)
      const top = await folderAt(names)
      const matches: Entry[] = []
      const queue = [{ id: top, path: joinRelative(names), depth: 0 }]
      let folders = 0
      let stopped: string | undefined

      while (queue.length > 0 && !stopped) {
        const next = queue.shift()!

        if (++folders > MAX_FIND_FOLDERS) {
          stopped = `It looked in ${MAX_FIND_FOLDERS} folders and stopped: name a folder further down as path.`
          break
        }

        for (const row of await children(next.id)) {
          const entry = entryOf(next.path, row)

          if (test(entry.name) && (!type || entry.type === type)) {
            matches.push(entry)

            if (matches.length >= limit) {
              stopped = `It found ${limit} and stopped: raise limit or narrow the pattern.`
              break
            }
          }

          if (row.folder && next.depth < MAX_DEPTH) {
            queue.push({ id: row.id, path: entry.path, depth: next.depth + 1 })
          }
        }
      }

      matches.sort((a, b) => a.path.localeCompare(b.path))
      const found: Found = { path: joinRelative(names), matches }
      if (stopped) found.stopped = stopped
      return found
    },

    async read(raw, maxBytes) {
      const { names, entry, meta } = await fileEntry(raw)
      const size = meta.s ?? 0

      if (size > maxBytes) {
        throw new FileTooLargeError(size)
      }

      const chunks: Buffer[] = []
      for await (const chunk of readObject(store, fs, entry, size, {
        offset: 0,
        length: size,
      })) {
        chunks.push(chunk as Buffer)
      }

      return {
        path: joinRelative(names),
        name: meta.n,
        bytes: Buffer.concat(chunks),
        modified: meta.m,
      }
    },

    async sealed(raw) {
      const { names, entry, meta } = await fileEntry(raw)

      if (!entry.fileKey) {
        throw new PcpError("state", "A file of the store's index has no key.")
      }

      return {
        path: joinRelative(names),
        name: meta.n,
        size: meta.s ?? 0,
        modified: meta.m,
        objectId: entry.objectId,
        fileKey: unwrapFileKey(
          store.storeKey,
          serverId,
          entry.objectId,
          entry.fileKey,
        ),
        rootReal: store.rootReal,
      }
    },

    async open(raw, range) {
      const { names, entry, meta } = await fileEntry(raw)
      const size = meta.s ?? 0
      const { offset, length } = clampRange(size, range)

      const opened: OpenedFile = {
        path: joinRelative(names),
        name: meta.n,
        size,
        modified: meta.m,
        offset,
        length,
        stream: readObject(store, fs, entry, size, { offset, length }),
      }
      return opened
    },

    save(raw, bytes, { overwrite }) {
      return folder.saveFrom(raw, [bytes], { overwrite })
    },

    async saveFrom(raw, source, { overwrite, maxBytes }) {
      const { names, parentId, leaf, entry } = await place(raw)

      if (names.length === 0) {
        throw new PcpError(
          "validation",
          "Name the file to save, not the store.",
        )
      }

      if (entry?.folder) {
        throw new PcpError(
          "conflict",
          `${joinRelative(names)} is a folder; a file cannot take its place.`,
        )
      }

      if (entry && !overwrite) {
        throw new PcpError(
          "conflict",
          `${joinRelative(names)} is there already. Pass overwrite: true to replace it, or choose another name.`,
        )
      }

      const object = await writeObject(store, fs, source, {
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      })
      const { replaced } = await commit(parentId, leaf, object, { overwrite })
      return { path: joinRelative(names), size: object.size, replaced }
    },

    async makeFolder(raw, { parents }) {
      const names = splitPath(raw)
      let id = ""
      let existed = true

      for (let index = 0; index < names.length; index++) {
        const name = names[index]!
        const label = joinRelative(names.slice(0, index + 1))
        const found = await child(id, name)

        if (found) {
          if (!found.folder) {
            throw new PcpError(
              "conflict",
              `${label} is there already, and is not a folder.`,
            )
          }
          id = found.id
          continue
        }

        if (index < names.length - 1 && !parents) {
          throw new PcpError(
            "not_found",
            `${label} is not there. Pass parents: true to make it too.`,
          )
        }

        const made = newId()

        try {
          await db().storageEntry.create({
            data: {
              id: made,
              serverId,
              parentId: id,
              nameKey: key(id, name),
              folder: true,
              meta: asBytes(
                sealMeta(ctx, made, { n: name, m: new Date().toISOString() }),
              ),
            },
          })
          id = made
        } catch (error) {
          if (!isUniqueClash(error)) throw error
          // Made meanwhile: go on through it.
          const again = await child(id, name)
          if (!again?.folder) {
            throw new PcpError("conflict", `${label} is there already.`)
          }
          id = again.id
          continue
        }

        existed = false
      }

      return { path: joinRelative(names), existed }
    },

    async move(fromRaw, toRaw, { overwrite }) {
      const from = await place(fromRaw)
      const to = await place(toRaw)

      if (from.names.length === 0 || to.names.length === 0) {
        throw new PcpError(
          "validation",
          "The store itself cannot be moved, or be moved onto.",
        )
      }

      if (!from.entry) {
        throw new PcpError(
          "not_found",
          `${joinRelative(from.names)} is not there.`,
        )
      }

      const moving = from.entry

      if (to.entry?.id === moving.id) {
        return {
          from: joinRelative(from.names),
          to: joinRelative(to.names),
          replaced: false,
        }
      }

      if (moving.folder) {
        // Not into itself: no folder above the target is the one moving.
        let at = to.parentId
        while (at !== "") {
          if (at === moving.id) {
            throw new PcpError(
              "validation",
              "A folder cannot be moved into itself.",
            )
          }
          const up = await db().storageEntry.findUnique({ where: { id: at } })
          at = up?.parentId ?? ""
        }
      }

      if (to.entry && (!overwrite || to.entry.folder || moving.folder)) {
        throw new PcpError(
          "conflict",
          to.entry.folder
            ? `${joinRelative(to.names)} is a folder: name the new path in full, inside it (${joinRelative([...to.names, from.leaf])}).`
            : `${joinRelative(to.names)} is there already. Pass overwrite: true to replace it.`,
        )
      }

      const meta = openMeta(ctx, moving)
      const replacedObject = to.entry?.objectId ?? null

      try {
        await db().$transaction(async (tx) => {
          if (to.entry) {
            await tx.storageEntry.delete({ where: { id: to.entry.id } })
            await tx.storagePending.create({
              data: {
                objectId: to.entry.objectId,
                serverId,
                createdAt: new Date(0),
              },
            })
          }

          await tx.storageEntry.update({
            where: { id: moving.id },
            data: {
              parentId: to.parentId,
              nameKey: key(to.parentId, to.leaf),
              meta: asBytes(sealMeta(ctx, moving.id, { ...meta, n: to.leaf })),
            },
          })
        })
      } catch (error) {
        if (isUniqueClash(error)) {
          throw new PcpError(
            "conflict",
            `${joinRelative(to.names)} appeared meanwhile; nothing was moved.`,
          )
        }
        throw error
      }

      if (replacedObject) await letGo()

      return {
        from: joinRelative(from.names),
        to: joinRelative(to.names),
        replaced: replacedObject !== null,
      }
    },

    async remove(raw, { recursive }) {
      const { names, entry } = await place(raw)

      if (names.length === 0) {
        throw new PcpError(
          "validation",
          "The store itself cannot be deleted here.",
        )
      }

      if (!entry) {
        throw new PcpError("not_found", `${joinRelative(names)} is not there.`)
      }

      const inside = entry.folder ? await descendants(entry.id) : []

      if (inside.length > 0 && !recursive) {
        throw new PcpError(
          "conflict",
          `${joinRelative(names)} is not empty. Pass recursive: true to delete it with everything in it.`,
        )
      }

      const all = [...inside, entry]
      const objects = all
        .filter((row) => !row.folder)
        .map((row) => row.objectId)

      await db().$transaction(async (tx) => {
        await tx.storagePending.createMany({
          data: objects.map((objectId) => ({
            objectId,
            serverId,
            createdAt: new Date(0),
          })),
        })
        await tx.storageEntry.deleteMany({
          where: { id: { in: all.map((row) => row.id) } },
        })
      })

      if (objects.length > 0) await letGo()

      return {
        path: joinRelative(names),
        type: entry.folder ? "folder" : "file",
        removed: all.length,
      }
    },

    async probeWrite() {
      const dir = under(store.rootReal, [OBJECTS_FOLDER])
      await ensureDir(fs, dir, 0o777 & ~store.umask)
      const part = under(dir, [`.pcp-check${partSuffix()}${PART_SUFFIX}`])
      await fs.writeNew(part, Buffer.alloc(0), 0o666 & ~store.umask)
      await fs.unlink(part).catch(() => {})
    },
  }

  return folder
}
