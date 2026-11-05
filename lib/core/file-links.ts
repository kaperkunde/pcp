import { hkdfSync } from "node:crypto"

import type { FileLink } from "@/lib/generated/prisma/client"

import type { VaultContext } from "./context"
import {
  asBytes,
  decrypt,
  encrypt,
  encryptString,
  randomSecret,
  sha256Hex,
} from "./crypto"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import {
  bareType,
  charsetOf,
  fileMediaType,
  isTextBytes,
  isTextType,
} from "./media-types"
import { appendRequestLog } from "./request-log"
import { loadResourceLimits } from "./resources/state"
import { describeResults, openResult, RESULT_TTL_MS } from "./tool-results"

/**
 * Links that move a file between PCP and an assistant's own computer (its
 * sandbox, its terminal) without the file's bytes passing through the
 * assistant: a token with `shareFiles` asks for one with share_result (a
 * download of a result it kept: a browser download, a mail attachment) or
 * receive_file (an upload, which becomes a result of its own), and fetches
 * or sends the file with curl (app/api/files/[secret]/route.ts).
 *
 * The link's secret (256 bits) is the credential, for that one file and
 * nothing else:
 *
 * - the row stores only the secret's hash, and the file encrypted under a
 *   key derived from the secret and the row's id, so neither the database
 *   nor the link opens anything but that file, and serving it needs no
 *   vault key;
 * - an upload's key is also wrapped under the vault's data key, so the file
 *   that arrives becomes the token's kept result (tool-results.ts, under the
 *   id its handle named from the start) the first time the token, holding
 *   the vault's key, uses the handle;
 * - a link works for the token that asked, while it is live and still has
 *   `shareFiles`, for FILE_LINK_TTL_MS (never past the result it serves); a
 *   download for MAX_LINK_DOWNLOADS fetches, an upload once. An upload that
 *   arrived waits a day, as a kept result would, to be used.
 *
 * Every use is in the request log, by name, as a call is. Links are not
 * exported, are wiped with the vault, go with their token, and the cleanup
 * removes them once their time is up.
 *
 * An upload page (upload-links.ts) is the one link for the owner rather
 * than the assistant's computer: each file it takes is a row here too, made
 * with the page (`uploadLinkId`), which no request reaches by its own hash.
 */

/** How long a link works: time to run curl, not to keep a file. */
export const FILE_LINK_TTL_MS = 60 * 60_000
/** Fetches of one download link: room for a retry or two. */
export const MAX_LINK_DOWNLOADS = 5
/** Links of one token that have not expired, used or not. */
export const MAX_LIVE_LINKS_PER_TOKEN = 20

/** What a link's secret looks like: randomSecret's 32 bytes, base64url. */
const SECRET = /^[A-Za-z0-9_-]{43}$/

/** Whether a string has the shape of a link's secret; checks nothing else. */
export function isLinkSecret(secret: string): boolean {
  return SECRET.test(secret)
}

/**
 * The key a file sent by link is held under: from the link's secret and the
 * row's id, so only the link opens it. Also an upload page's
 * (upload-links.ts), for its purpose and each of its files.
 */
export function linkKey(secret: string, id: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.alloc(0),
      `pcp file link:${id}`,
      32,
    ),
  )
}

export function fileAad(id: string): string {
  return `file_link:${id}`
}

export function keyAad(id: string): string {
  return `file_link_key:${id}`
}

/** An upload's store folder, then its path there (store-uploads.ts). */
export function storePathAad(id: string): string {
  return `file_link_store_path:${id}`
}

/** Where a link is fetched or sent: under PCP's public address. */
export function fileLinkUrl(publicUrl: string, secret: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/files/${secret}`
}

export async function roomForLink(
  ctx: VaultContext,
  tokenId: string,
  now: Date,
): Promise<void> {
  // An upload page's files count against the pages it may keep open
  // (upload-links.ts), not here.
  const live = await db().fileLink.count({
    where: {
      vaultId: ctx.vaultId,
      tokenId,
      uploadLinkId: null,
      expiresAt: { gt: now },
    },
  })

  if (live >= MAX_LIVE_LINKS_PER_TOKEN) {
    throw invalid(
      `This token has ${MAX_LIVE_LINKS_PER_TOKEN} file links that have not expired, as many as it keeps. Each ends an hour after it was made.`,
    )
  }
}

export type SharedLink = {
  url: string
  expiresAt: Date
  maxUses: number
  name: string | null
  mediaType: string
  size: number
}

/**
 * A download link for one of the token's kept results: its bytes (a text's
 * as UTF-8), copied under the link's own key.
 */
export async function shareResult(
  ctx: VaultContext,
  input: { tokenId: string; id: string; publicUrl: string },
  now = new Date(),
): Promise<SharedLink> {
  const [info] = await describeResults(ctx, input.tokenId, [input.id], now)
  const opened = info?.found
    ? await openResult(ctx, { tokenId: input.tokenId, id: input.id }, now)
    : null

  if (!info?.found || !opened) {
    throw notFound("That result")
  }

  await roomForLink(ctx, input.tokenId, now)

  const id = newId()
  const secret = randomSecret()
  const bytes = opened.bytes()
  const mediaType =
    opened.kind === "text" && !/;\s*charset=/i.test(opened.mediaType)
      ? `${bareType(opened.mediaType)}; charset=utf-8`
      : opened.mediaType
  const expiresAt = new Date(
    Math.min(now.getTime() + FILE_LINK_TTL_MS, info.expiresAt.getTime()),
  )

  await db().fileLink.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      kind: "download",
      secretHash: sha256Hex(secret),
      resultId: opened.id,
      name: opened.name,
      mediaType,
      length: bytes.length,
      ciphertext: asBytes(encrypt(linkKey(secret, id), bytes, fileAad(id))),
      maxUses: MAX_LINK_DOWNLOADS,
      createdAt: now,
      expiresAt,
    },
  })

  return {
    url: fileLinkUrl(input.publicUrl, secret),
    expiresAt,
    maxUses: MAX_LINK_DOWNLOADS,
    name: opened.name,
    mediaType,
    size: bytes.length,
  }
}

export type UploadLink = {
  url: string
  /** The id the file is kept under once it arrived: its handle's. */
  resultId: string
  expiresAt: Date
}

/**
 * An upload link: the file sent to it becomes a result of the token's,
 * named `name` (and of `type`, or what its name and bytes say).
 */
export async function receiveFile(
  ctx: VaultContext,
  input: {
    tokenId: string
    publicUrl: string
    name?: string | null
    type?: string | null
    /** A store to save the file in too (store-uploads.ts). */
    destination?: { storeId: string; folder: string } | null
  },
  now = new Date(),
): Promise<UploadLink> {
  await roomForLink(ctx, input.tokenId, now)

  const id = newId()
  const resultId = newId()
  const secret = randomSecret()
  const expiresAt = new Date(now.getTime() + FILE_LINK_TTL_MS)

  await db().fileLink.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      kind: "upload",
      secretHash: sha256Hex(secret),
      resultId,
      name: input.name ?? null,
      mediaType: input.type ?? "",
      wrappedKey: asBytes(encrypt(ctx.dek, linkKey(secret, id), keyAad(id))),
      maxUses: 1,
      createdAt: now,
      expiresAt,
      ...(input.destination
        ? {
            storeId: input.destination.storeId,
            storePath: asBytes(
              encryptString(
                ctx.dek,
                input.destination.folder,
                storePathAad(id),
              ),
            ),
          }
        : {}),
    },
  })

  return { url: fileLinkUrl(input.publicUrl, secret), resultId, expiresAt }
}

/** A link's request, refused: the status and what to say. */
export type LinkRefusal = { ok: false; status: number; message: string }

export const GONE: LinkRefusal = {
  ok: false,
  status: 404,
  message:
    "No such link, or it has expired (a link works for an hour). Ask PCP for a new one.",
}

/** The live link a secret names, of a kind, whose token may still use it. */
async function findLink(
  secret: string,
  kind: "download" | "upload",
  now: Date,
): Promise<FileLink | null> {
  if (!SECRET.test(secret)) {
    return null
  }

  const link = await db().fileLink.findUnique({
    where: { secretHash: sha256Hex(secret) },
    include: {
      token: { select: { revokedAt: true, expiresAt: true, shareFiles: true } },
    },
  })

  if (
    !link ||
    link.kind !== kind ||
    link.uploadLinkId !== null ||
    link.expiresAt <= now ||
    !tokenCanUseLinks(link.token, now)
  ) {
    return null
  }

  return link
}

/** Whether a link's token is live and may still move files by link. */
export function tokenCanUseLinks(
  token: {
    revokedAt: Date | null
    expiresAt: Date | null
    shareFiles: boolean
  },
  now: Date,
): boolean {
  return (
    !token.revokedAt &&
    token.shareFiles &&
    !(token.expiresAt && token.expiresAt <= now)
  )
}

export function logUse(
  link: Pick<FileLink, "vaultId" | "tokenId">,
  tool: string,
  ok: boolean,
  started: number,
): Promise<void> {
  return appendRequestLog({
    vaultId: link.vaultId,
    tokenId: link.tokenId,
    tool,
    ok,
    ms: Date.now() - started,
  })
}

export type LinkedFile = {
  ok: true
  name: string | null
  mediaType: string
  bytes: Buffer
}

/** The file a download link serves, counted as one of its fetches. */
export async function downloadByLink(
  secret: string,
  now = new Date(),
): Promise<LinkedFile | LinkRefusal> {
  const started = Date.now()
  const link = await findLink(secret, "download", now)

  if (!link?.ciphertext) {
    return GONE
  }

  const { count } = await db().fileLink.updateMany({
    where: { id: link.id, uses: { lt: link.maxUses } },
    data: { uses: { increment: 1 } },
  })

  if (count === 0) {
    await logUse(link, "file_link/download", false, started)
    return {
      ok: false,
      status: 410,
      message: `This link has been used ${link.maxUses} times, as often as it works. Ask PCP for a new one.`,
    }
  }

  const bytes = decrypt(
    linkKey(secret, link.id),
    Buffer.from(link.ciphertext),
    fileAad(link.id),
  )

  await logUse(link, "file_link/download", true, started)
  return { ok: true, name: link.name, mediaType: link.mediaType, bytes }
}

/** Types a sender sets for any bytes, which say nothing of the file. */
const SAYS_NOTHING = new Set([
  "",
  "application/octet-stream",
  "application/x-www-form-urlencoded",
])

/**
 * The media type of a file sent by link: the one asked for, else what the
 * request says, else (when it says nothing of the file) what its name and
 * first bytes say.
 */
export function sentMediaType({
  asked,
  contentType,
  name,
  bytes,
}: {
  asked: string
  contentType: string | null
  name: string | null
  bytes: Buffer
}): string {
  const sent = bareType(contentType ?? "")
  const said = (contentType ?? "").trim().slice(0, 200)

  return (
    asked ||
    (SAYS_NOTHING.has(sent)
      ? fileMediaType(name ?? "", bytes)
      : isTextType(said) && !charsetOf(said) && isTextBytes(bytes)
        ? `${sent}; charset=utf-8`
        : said)
  )
}

/** Reads a body up to `max` bytes; null past it. */
async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  max: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of body ?? []) {
    total += chunk.length

    if (total > max) {
      return null
    }

    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

/**
 * The file a request sends, as its body: never a form, and no larger than
 * PCP keeps of one file (the resource limit), counted as it comes.
 */
export async function readSentFile(
  body: AsyncIterable<Uint8Array> | null,
  {
    contentType,
    contentLength,
  }: { contentType: string | null; contentLength: number | null },
): Promise<{ ok: true; bytes: Buffer } | LinkRefusal> {
  if (bareType(contentType ?? "").startsWith("multipart/")) {
    return {
      ok: false,
      status: 415,
      message:
        "Send the file's bytes as the body (curl -T file, or --data-binary @file), not as a form.",
    }
  }

  const { fileBytes } = await loadResourceLimits()
  const tooLarge: LinkRefusal = {
    ok: false,
    status: 413,
    message: `The file is larger than PCP keeps of one (${fileBytes.toLocaleString("en")} bytes). The owner can raise that in PCP's settings, under Resources.`,
  }

  if (contentLength !== null && contentLength > fileBytes) {
    return tooLarge
  }

  const bytes = await readCapped(body, fileBytes)

  return bytes ? { ok: true, bytes } : tooLarge
}

export type ReceivedFile = {
  ok: true
  resultId: string
  name: string | null
  mediaType: string
  size: number
  readableUntil: Date
}

/**
 * Takes the file an upload link is sent, once: kept under the link's key
 * until the token uses its handle (tool-results.ts claims it).
 */
export async function uploadByLink(
  secret: string,
  body: AsyncIterable<Uint8Array> | null,
  {
    contentType,
    contentLength,
  }: { contentType: string | null; contentLength: number | null },
  now = new Date(),
): Promise<ReceivedFile | LinkRefusal> {
  const started = Date.now()
  const link = await findLink(secret, "upload", now)

  if (!link) {
    return GONE
  }

  if (link.receivedAt) {
    await logUse(link, "file_link/upload", false, started)
    return {
      ok: false,
      status: 409,
      message:
        "A file has already been sent to this link. Ask PCP for a new one to send another.",
    }
  }

  const read = await readSentFile(body, { contentType, contentLength })

  if (!read.ok) {
    // A form is refused before anything is read: not a use of the link.
    if (read.status !== 415) {
      await logUse(link, "file_link/upload", false, started)
    }

    return read
  }

  const { bytes } = read
  const mediaType = sentMediaType({
    asked: link.mediaType,
    contentType,
    name: link.name,
    bytes,
  })
  const readableUntil = new Date(now.getTime() + RESULT_TTL_MS)
  const { count } = await db().fileLink.updateMany({
    where: { id: link.id, receivedAt: null },
    data: {
      receivedAt: now,
      uses: 1,
      length: bytes.length,
      mediaType,
      ciphertext: asBytes(
        encrypt(linkKey(secret, link.id), bytes, fileAad(link.id)),
      ),
      expiresAt: readableUntil,
    },
  })

  if (count === 0) {
    await logUse(link, "file_link/upload", false, started)
    return {
      ok: false,
      status: 409,
      message:
        "A file has already been sent to this link. Ask PCP for a new one to send another.",
    }
  }

  await logUse(link, "file_link/upload", true, started)
  return {
    ok: true,
    resultId: link.resultId,
    name: link.name,
    mediaType,
    size: bytes.length,
    readableUntil,
  }
}

/** Links past their time, and uploads nobody used; for the cleanup. */
export async function pruneFileLinks(now = new Date()): Promise<number> {
  const { count } = await db().fileLink.deleteMany({
    where: { expiresAt: { lte: now } },
  })

  return count
}
