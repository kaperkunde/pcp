import { createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Transform, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import type { VaultContext } from "./context"
import { asBytes, decrypt, encrypt, randomSecret, sha256Hex } from "./crypto"
import { dataDir } from "./data-dir"
import { db } from "./db"
import { invalid } from "./errors"
import {
  fileLinkUrl,
  GONE,
  isLinkSecret,
  linkKey,
  type LinkRefusal,
  logUse,
  openLinkName,
  roomForLink,
  sealLinkName,
  tokenCanUseLinks,
} from "./file-links"
import { newId } from "./ids"
import { fileMediaType } from "./media-types"
import { encryptStream, newKey, newObjectId, OBJECT_ID } from "./storage/crypt"
import { objectPath, openSealedObject } from "./storage/encrypted"
import type { StorageFolder } from "./storage/files"
import {
  DEFAULT_STORE_LINK_DOWNLOADS,
  DEFAULT_STORE_LINK_MINUTES,
  MAX_STORE_LINK_DOWNLOADS,
  MAX_STORE_LINK_MINUTES,
  MIN_STORE_LINK_MINUTES,
  OBJECTS_FOLDER,
  PART_FILE_AGE_MS,
  PART_SUFFIX,
} from "./storage/limits"
import { localFs, localStoreDir } from "./storage/local"
import { FileTooLargeError, partSuffix } from "./storage/sftp"

/**
 * Public download links to one file of a store (share_file): a FileLink of
 * kind "store", for whoever the assistant or the owner gives it to. The
 * link's secret is the credential, for that one file, as a file link's is
 * (file-links.ts): the row keeps only its hash, and the one file's key,
 * wrapped under a key derived from the secret (linkKey, "pcp file
 * link:<id>"), so serving it needs no vault key, no store key and no SSH
 * key, and the database alone opens nothing.
 *
 * - A file of PCP's own store, encrypted (the data folder): the link wraps
 *   the key the store already sealed that file under, and the public route
 *   reads its object in place with that key alone (storage/encrypted.ts
 *   openSealedObject). The link ends with the file: once it is changed or
 *   deleted, the index no longer names that object, and the link answers
 *   that it is gone.
 * - A file anywhere else (a store on an SSH server, which only a request
 *   holding PCP's key reaches, or a plain store): copied when it is shared,
 *   sealed as a store's object is under a key of its own, into the data
 *   folder (file-links/), and served from there. Later changes to the file
 *   do not reach the copy; the copy goes with the link.
 *
 * Either way the file is read in ranges (HTTP Range) as it streams. A link
 * serves maxUses times the file's size, ranges counted, so a player that
 * seeks or a download that resumes costs what it reads. It works while its
 * token is live and still has `shareFiles`, until it expires (up to
 * MAX_STORE_LINK_MINUTES). Every use is in the request log by name; links
 * are never exported, are wiped with the vault, go with their token, and
 * the cleanup removes rows past their time and the copies no row names.
 */

/** A copy no link names is left this long first: a share still writing it. */
const ORPHAN_COPY_AGE_MS = 10 * 60_000
/** Bytes read to tell a file's type when its name does not. */
const SNIFF_BYTES = 512

/** Where copies of shared files are: <data>/file-links, as a store's objects. */
export function linkCopiesDir(): string {
  return path.join(dataDir(), "file-links")
}

/** What the file's key is wrapped with, under the link's key. */
export function linkFileKeyAad(id: string): string {
  return `file_link_file_key:${id}`
}

/**
 * Why the token may not make a link now, or null: it must be live and have
 * `shareFiles`, which the owner sets on the token's page.
 */
export async function shareRefusal(
  ctx: VaultContext,
  tokenId: string | undefined,
  now = new Date(),
): Promise<string | null> {
  const token = tokenId
    ? await db().apiToken.findFirst({
        where: { id: tokenId, vaultId: ctx.vaultId },
        select: { revokedAt: true, expiresAt: true, shareFiles: true },
      })
    : null

  return token && tokenCanUseLinks(token, now)
    ? null
    : 'This token does not share files by link: the owner allows that on the token\'s page in PCP ("Move files by link").'
}

export type SharedStoreFile = {
  url: string
  expiresAt: Date
  /** Whole downloads it serves; ranges count what they read. */
  maxDownloads: number
  name: string
  mediaType: string
  size: number
  /** Copied when shared (served from the copy), or read in place. */
  copied: boolean
}

/** Copies a file as it streams, sealed under a key of its own. */
async function sealCopy(
  source: Readable,
  maxBytes: number,
): Promise<{ objectId: string; fileKey: Buffer; size: number; head: Buffer }> {
  const objectId = newObjectId()
  const fileKey = newKey()
  const final = objectPath(linkCopiesDir(), objectId)
  const part = `${final}${partSuffix()}${PART_SUFFIX}`
  let size = 0
  let head = Buffer.alloc(0)

  await fs.mkdir(path.dirname(final), { recursive: true, mode: 0o700 })

  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length

      if (size > maxBytes) {
        done(new FileTooLargeError(size))
        return
      }

      if (head.length < SNIFF_BYTES) {
        head = Buffer.concat([head, chunk]).subarray(0, SNIFF_BYTES)
      }

      done(null, chunk)
    },
  })

  try {
    await pipeline(
      source,
      counted,
      encryptStream(fileKey, objectId),
      createWriteStream(part, { flags: "wx", mode: 0o600 }),
    )
    await fs.rename(part, final)
  } catch (error) {
    await fs.rm(part, { force: true })
    throw error
  }

  return { objectId, fileKey, size, head }
}

/** The first bytes of a file, to tell its type. */
async function firstBytes(
  folder: StorageFolder,
  at: string,
  size: number,
): Promise<Buffer> {
  const opened = await folder.open(at, {
    offset: 0,
    length: Math.min(size, SNIFF_BYTES),
  })
  const chunks: Buffer[] = []

  for await (const chunk of opened.stream) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks)
}

function checkedBound(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  what: string,
): number {
  const chosen = value ?? fallback

  if (!Number.isInteger(chosen) || chosen < min || chosen > max) {
    throw invalid(`${what} is ${min} to ${max}.`)
  }

  return chosen
}

/**
 * A public download link to one file of a store, opened for this request
 * (`folder`). `direct` reads it in place later (PCP's own store,
 * encrypted); otherwise it is copied now, up to `maxBytes`.
 */
export async function shareStoreFile(
  ctx: VaultContext,
  input: {
    tokenId: string
    publicUrl: string
    storeId: string
    folder: StorageFolder
    direct: boolean
    path: string
    minutes?: number
    downloads?: number
    maxBytes: number
  },
  now = new Date(),
): Promise<SharedStoreFile> {
  const minutes = checkedBound(
    input.minutes,
    DEFAULT_STORE_LINK_MINUTES,
    MIN_STORE_LINK_MINUTES,
    MAX_STORE_LINK_MINUTES,
    "A link's time in minutes",
  )
  const downloads = checkedBound(
    input.downloads,
    DEFAULT_STORE_LINK_DOWNLOADS,
    1,
    MAX_STORE_LINK_DOWNLOADS,
    "A link's downloads",
  )

  await roomForLink(ctx, input.tokenId, now)

  const { folder } = input
  let file: {
    objectId: string
    fileKey: Buffer
    size: number
    name: string
    head: Buffer
    storeId: string | null
  }

  if (input.direct && folder.sealed) {
    const sealed = await folder.sealed(input.path)

    file = {
      objectId: sealed.objectId,
      fileKey: sealed.fileKey,
      size: sealed.size,
      name: sealed.name,
      head: await firstBytes(folder, input.path, sealed.size),
      storeId: input.storeId,
    }
  } else {
    const opened = await folder.open(input.path)

    if (opened.size > input.maxBytes) {
      opened.stream.destroy()
      throw new FileTooLargeError(opened.size)
    }

    const copy = await sealCopy(opened.stream, input.maxBytes)
    file = { ...copy, name: opened.name, storeId: null }
  }

  const id = newId()
  const secret = randomSecret()
  const mediaType = fileMediaType(file.name, file.head)
  const expiresAt = new Date(now.getTime() + minutes * 60_000)

  try {
    await db().fileLink.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        tokenId: input.tokenId,
        kind: "store",
        secretHash: sha256Hex(secret),
        resultId: "",
        sealedName: sealLinkName(linkKey(secret, id), id, file.name),
        mediaType,
        length: file.size,
        storeId: file.storeId,
        objectId: file.objectId,
        fileKey: asBytes(
          encrypt(linkKey(secret, id), file.fileKey, linkFileKeyAad(id)),
        ),
        maxUses: downloads,
        createdAt: now,
        expiresAt,
      },
    })
  } catch (error) {
    if (!file.storeId) {
      await fs.rm(objectPath(linkCopiesDir(), file.objectId), { force: true })
    }
    throw error
  }

  return {
    url: fileLinkUrl(input.publicUrl, secret),
    expiresAt,
    maxDownloads: downloads,
    name: file.name,
    mediaType,
    size: file.size,
    copied: !file.storeId,
  }
}

/** The part of a file a request asks for: whole, a range, or none of it. */
export type AskedRange =
  { offset: number; length: number; partial: boolean } | "unsatisfiable"

/**
 * A Range header (RFC 9110) against a file of `size` bytes: one range of
 * bytes, else the whole file (several ranges, another unit and a header
 * that does not parse are served whole, as the RFC lets a server).
 */
export function parseRange(header: string | null, size: number): AskedRange {
  const whole = { offset: 0, length: size, partial: false }
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? "")

  if (!match || size === 0 || (match[1] === "" && match[2] === "")) {
    return whole
  }

  const [, first, last] = match

  if (first === "") {
    // The last n bytes.
    const count = Number(last)

    if (!Number.isSafeInteger(count)) return whole
    if (count === 0) return "unsatisfiable"

    const offset = Math.max(0, size - count)
    return { offset, length: size - offset, partial: true }
  }

  const offset = Number(first)
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1)

  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end)) {
    return whole
  }

  if (last !== "" && Number(last) < offset) {
    return whole
  }

  if (offset >= size) {
    return "unsatisfiable"
  }

  return { offset, length: end - offset + 1, partial: true }
}

export type StoreLinkFile = {
  ok: true
  name: string | null
  mediaType: string
  /** The whole file's size. */
  size: number
  offset: number
  length: number
  /** A range was asked for and is served (206). */
  partial: boolean
  stream: Readable
}

export type StoreLinkRefusal = LinkRefusal & { size?: number }

const CHANGED: LinkRefusal = {
  ok: false,
  status: 410,
  message:
    "The file this link shared has been changed or deleted since. Ask for a new link.",
}

/**
 * The file a store link serves, whole or the range asked for, counted
 * against what it may serve. Null when the secret is no store link's (a
 * file link's, which downloadByLink serves).
 */
export async function openStoreLink(
  secret: string,
  rangeHeader: string | null,
  now = new Date(),
): Promise<StoreLinkFile | StoreLinkRefusal | null> {
  if (!isLinkSecret(secret)) {
    return null
  }

  const link = await db().fileLink.findUnique({
    where: { secretHash: sha256Hex(secret) },
    include: {
      token: { select: { revokedAt: true, expiresAt: true, shareFiles: true } },
    },
  })

  if (!link || link.kind !== "store") {
    return null
  }

  const started = Date.now()

  if (
    link.expiresAt <= now ||
    !tokenCanUseLinks(link.token, now) ||
    !link.objectId ||
    !OBJECT_ID.test(link.objectId) ||
    !link.fileKey
  ) {
    return GONE
  }

  const size = link.length
  const range = parseRange(rangeHeader, size)

  if (range === "unsatisfiable") {
    await logUse(link, "file_link/store_download", false, started)
    return {
      ok: false,
      status: 416,
      message: `That range is not in the file, which has ${size} bytes.`,
      size,
    }
  }

  let top = linkCopiesDir()

  if (link.storeId) {
    // Still the file that was shared: the store's index names its object.
    const [entry, root] = await Promise.all([
      db().storageEntry.findFirst({
        where: { serverId: link.storeId, objectId: link.objectId },
        select: { id: true },
      }),
      db().storageRoot.findUnique({
        where: { serverId: link.storeId },
        select: { backend: true, mode: true, converting: true },
      }),
    ])

    if (
      !entry ||
      root?.backend !== "local" ||
      root.mode !== "encrypted" ||
      root.converting !== ""
    ) {
      await logUse(link, "file_link/store_download", false, started)
      return CHANGED
    }

    top = await fs.realpath(localStoreDir(link.storeId)).catch(() => "")
  }

  const object = top ? objectPath(top, link.objectId) : ""
  const there = object ? await fs.stat(object).catch(() => null) : null

  if (!there?.isFile()) {
    await logUse(link, "file_link/store_download", false, started)
    return link.storeId ? CHANGED : GONE
  }

  // What it may serve is maxUses times the file; each request costs what
  // it reads (at least one, so an empty file counts its downloads).
  const cost = Math.max(range.length, 1)
  const budget = link.maxUses * Math.max(size, 1)
  const { count } = await db().fileLink.updateMany({
    where: { id: link.id, servedBytes: { lte: budget - cost } },
    data: { servedBytes: { increment: cost } },
  })

  if (count === 0) {
    await logUse(link, "file_link/store_download", false, started)
    return {
      ok: false,
      status: 410,
      message: `This link has served the file ${link.maxUses} times, as often as it works. Ask for a new one.`,
    }
  }

  const fileKey = decrypt(
    linkKey(secret, link.id),
    Buffer.from(link.fileKey),
    linkFileKeyAad(link.id),
  )
  const stream = openSealedObject(
    localFs(),
    top,
    link.objectId,
    fileKey,
    size,
    { offset: range.offset, length: range.length },
  )

  await logUse(link, "file_link/store_download", true, started)
  return {
    ok: true,
    name: openLinkName(linkKey(secret, link.id), link),
    mediaType: link.mediaType,
    size,
    offset: range.offset,
    length: range.length,
    partial: range.partial,
    stream,
  }
}

/**
 * Copies of shared files no link names any more (it expired and the
 * cleanup removed it, or its token or vault went), and part files a copy
 * left when it was cut off; for the cleanup, by names and dates alone.
 */
export async function pruneLinkCopies(
  now = new Date(),
): Promise<{ removed: number; freedBytes: number }> {
  const top = path.join(linkCopiesDir(), OBJECTS_FOLDER)
  const result = { removed: 0, freedBytes: 0 }
  const buckets = await fs.readdir(top, { withFileTypes: true }).catch(() => [])

  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const dir = path.join(top, bucket.name)
    const files = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const ids = files
      .map((entry) => entry.name)
      .filter((name) => OBJECT_ID.test(name))
    const named = new Set(
      ids.length === 0
        ? []
        : (
            await db().fileLink.findMany({
              where: { kind: "store", storeId: null, objectId: { in: ids } },
              select: { objectId: true },
            })
          ).map((row) => row.objectId),
    )

    for (const entry of files) {
      if (!entry.isFile()) continue
      const at = path.join(dir, entry.name)
      const stat = await fs.lstat(at).catch(() => null)
      if (!stat) continue
      const age = now.getTime() - stat.mtimeMs
      const stale = entry.name.endsWith(PART_SUFFIX)
        ? age > PART_FILE_AGE_MS
        : !named.has(entry.name) && age > ORPHAN_COPY_AGE_MS

      if (stale) {
        await fs.rm(at, { force: true })
        result.removed++
        result.freedBytes += stat.size
      }
    }
  }

  return result
}
