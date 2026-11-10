import type { VaultContext } from "./context"
import {
  asBytes,
  decrypt,
  decryptString,
  encrypt,
  encryptString,
  randomSecret,
  sha256Hex,
} from "./crypto"
import { db } from "./db"
import { invalid } from "./errors"
import {
  fileAad,
  GONE,
  isLinkSecret,
  keyAad,
  linkKey,
  type LinkRefusal,
  logUse,
  readSentFile,
  sentMediaType,
  storePathAad,
  tokenCanUseLinks,
} from "./file-links"
import { newId } from "./ids"
import { openLinkName, sealLinkName } from "./link-names"
import { TOKEN_NAME_SELECT, tokenName } from "./token-names"
import { RESULT_TTL_MS } from "./tool-results"

/**
 * Upload links: a page the owner opens on their phone or computer
 * (app/upload/[secret]/page.tsx) to hand an assistant files they have there
 * (a photo, a scan, a document) that the assistant could not otherwise
 * reach: a file dropped into a chat stays in the assistant's sandbox, and a
 * voice conversation has no way to send one. A token with `shareFiles` asks
 * for one with create_upload_link and gives the owner the link;
 * check_upload then says which files arrived, as handles.
 *
 * The link's secret is the credential, for this page alone, as a file
 * link's is (file-links.ts), and the model is the same:
 *
 * - the row stores only the secret's hash, and the purpose the page shows
 *   encrypted under a key derived from the secret, so the database shows
 *   neither the page nor what it is for;
 * - each file it may take is one FileLink row of kind "upload", made with
 *   the page: its result id fixed from the start, its key derived from the
 *   secret and the row's id and also wrapped under the vault's data key, so
 *   the file that arrives becomes the token's kept result
 *   (tool-results.ts claimUploads) only when the token uses its handle;
 * - it takes files for at most UPLOAD_LINK_TTL_MS until the first arrives,
 *   then for UPLOAD_AFTER_FIRST_MS more, until it has taken the files it
 *   was made for, or until the owner says Done; then it is closed. A file
 *   that arrived waits a day to be used, as a kept result would.
 *
 * Every file sent and every Done is in the request log, by name. Upload
 * links are not exported, are wiped with the vault, go with their token,
 * and the cleanup removes them once their time is up.
 */

/** The longest an upload link takes files before the first one arrives. */
export const UPLOAD_LINK_TTL_MS = 60 * 60_000
/** The shortest an assistant may ask for: time to find the files. */
export const MIN_UPLOAD_LINK_MINUTES = 5
/** How long it goes on taking files once the first has arrived. */
export const UPLOAD_AFTER_FIRST_MS = 15 * 60_000
/** Files one link takes when the assistant does not say. */
export const DEFAULT_UPLOAD_FILES = 5
/** The most files one link takes. */
export const MAX_UPLOAD_FILES = 10
/** Upload links of one token that still take files. */
export const MAX_OPEN_UPLOAD_LINKS_PER_TOKEN = 5
/** The longest purpose, in characters: a line the owner reads whole. */
export const MAX_PURPOSE_CHARS = 200
/** The longest file name kept, in characters. */
const MAX_NAME_CHARS = 255

function purposeAad(id: string): string {
  return `upload_link:${id}`
}

function assistantAad(id: string): string {
  return `upload_link_assistant:${id}`
}

function destinationAad(id: string): string {
  return `upload_link_destination:${id}`
}

/** Where the page's files go besides the assistant, as the page says it. */
export type UploadDestination = { store: string; folder: string }

function openDestination(
  secret: string,
  page: { id: string; destination: Uint8Array | null },
): UploadDestination | null {
  if (!page.destination) return null

  const value = JSON.parse(
    decryptString(
      linkKey(secret, page.id),
      Buffer.from(page.destination),
      destinationAad(page.id),
    ),
  ) as Partial<UploadDestination>

  return typeof value.store === "string" && typeof value.folder === "string"
    ? { store: value.store, folder: value.folder }
    : null
}

/** The hash a slot is stored under: unique, and no request looks it up. */
function slotHash(secret: string, slotId: string): string {
  return sha256Hex(`${secret}:${slotId}`)
}

/** The page the owner opens: under PCP's public address. */
export function uploadPageUrl(publicUrl: string, secret: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/upload/${secret}`
}

/**
 * What the files are for, as the page shows it: one line, no characters
 * that do not show, at most MAX_PURPOSE_CHARS.
 */
export function cleanPurpose(text: string): string {
  const plain = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!plain) {
    throw invalid("Say in a few words what the files are for.")
  }

  if ([...plain].length > MAX_PURPOSE_CHARS) {
    throw invalid(
      `Say what the files are for in at most ${MAX_PURPOSE_CHARS} characters.`,
    )
  }

  return plain
}

/**
 * A file's name as the page sent it (percent-encoded, as a header carries
 * it): without a path, characters that do not show, or more than
 * MAX_NAME_CHARS; null when nothing is left.
 */
export function cleanFileName(sent: string | null): string | null {
  if (!sent) {
    return null
  }

  let name = sent

  try {
    name = decodeURIComponent(sent)
  } catch {
    // Not percent-encoded: taken as it came.
  }

  const plain = (
    name
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
      .split(/[\\/]/)
      .pop() ?? ""
  )
    .replace(/\s+/g, " ")
    .trim()

  if (!plain || /^\.+$/.test(plain)) {
    return null
  }

  return [...plain].slice(0, MAX_NAME_CHARS).join("").trim()
}

export type CreatedUploadLink = {
  id: string
  url: string
  maxFiles: number
  acceptUntil: Date
}

/**
 * An upload link for the token: a page that takes up to `maxFiles` files
 * for `minutes` (then a quarter of an hour from the first file).
 */
export async function createUploadLink(
  ctx: VaultContext,
  input: {
    tokenId: string
    publicUrl: string
    purpose: string
    maxFiles?: number
    minutes?: number
    /**
     * A store to save the files in too (store-uploads.ts): its id, its
     * name as the page shows it, and the folder.
     */
    destination?: { storeId: string; storeName: string; folder: string }
  },
  now = new Date(),
): Promise<CreatedUploadLink> {
  const purpose = cleanPurpose(input.purpose)
  const maxFiles = input.maxFiles ?? DEFAULT_UPLOAD_FILES
  const minutes = input.minutes ?? UPLOAD_LINK_TTL_MS / 60_000

  if (
    !Number.isInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > MAX_UPLOAD_FILES
  ) {
    throw invalid(`An upload link takes 1 to ${MAX_UPLOAD_FILES} files.`)
  }

  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_UPLOAD_LINK_MINUTES ||
    minutes * 60_000 > UPLOAD_LINK_TTL_MS
  ) {
    throw invalid(
      `An upload link works for ${MIN_UPLOAD_LINK_MINUTES} to ${UPLOAD_LINK_TTL_MS / 60_000} minutes.`,
    )
  }

  const open = await db().uploadLink.count({
    where: {
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      closedAt: null,
      acceptUntil: { gt: now },
    },
  })

  if (open >= MAX_OPEN_UPLOAD_LINKS_PER_TOKEN) {
    throw invalid(
      `This token has ${MAX_OPEN_UPLOAD_LINKS_PER_TOKEN} upload links that still take files, as many as it keeps. Use one of those, or wait for one to close.`,
    )
  }

  const id = newId()
  const secret = randomSecret()
  const acceptUntil = new Date(now.getTime() + minutes * 60_000)
  // The page has the link's key only: the token's name goes on it sealed
  // under that.
  const token = await db().apiToken.findFirst({
    where: { id: input.tokenId, vaultId: ctx.vaultId },
    select: TOKEN_NAME_SELECT,
  })
  const assistant = token ? tokenName(ctx, token) : "An assistant"
  const slots = Array.from({ length: maxFiles }, () => ({
    id: newId(),
    resultId: newId(),
  }))

  await db().$transaction([
    db().uploadLink.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        tokenId: input.tokenId,
        secretHash: sha256Hex(secret),
        purpose: asBytes(
          encryptString(linkKey(secret, id), purpose, purposeAad(id)),
        ),
        maxFiles,
        resultIds: JSON.stringify(slots.map((slot) => slot.resultId)),
        destination: input.destination
          ? asBytes(
              encryptString(
                linkKey(secret, id),
                JSON.stringify({
                  store: input.destination.storeName,
                  folder: input.destination.folder,
                }),
                destinationAad(id),
              ),
            )
          : null,
        assistant: asBytes(
          encryptString(linkKey(secret, id), assistant, assistantAad(id)),
        ),
        createdAt: now,
        acceptUntil,
        expiresAt: new Date(acceptUntil.getTime() + RESULT_TTL_MS),
      },
    }),
    db().fileLink.createMany({
      data: slots.map((slot) => ({
        id: slot.id,
        vaultId: ctx.vaultId,
        tokenId: input.tokenId,
        kind: "upload",
        secretHash: slotHash(secret, slot.id),
        resultId: slot.resultId,
        mediaType: "",
        wrappedKey: asBytes(
          encrypt(ctx.dek, linkKey(secret, slot.id), keyAad(slot.id)),
        ),
        maxUses: 1,
        createdAt: now,
        // Until it stops taking files; a file that arrives, a day.
        expiresAt: acceptUntil,
        uploadLinkId: id,
        ...(input.destination
          ? {
              storeId: input.destination.storeId,
              storePath: asBytes(
                encryptString(
                  ctx.dek,
                  input.destination.folder,
                  storePathAad(slot.id),
                ),
              ),
            }
          : {}),
      })),
    }),
  ])

  return {
    id,
    url: uploadPageUrl(input.publicUrl, secret),
    maxFiles,
    acceptUntil,
  }
}

type PageRow = NonNullable<Awaited<ReturnType<typeof findPage>>>

/** The upload link a secret names, whatever its state; null for none. */
async function findPage(secret: string) {
  if (!isLinkSecret(secret)) {
    return null
  }

  return db().uploadLink.findUnique({
    where: { secretHash: sha256Hex(secret) },
    include: {
      token: {
        select: {
          plainName: true,
          sealedName: true,
          revokedAt: true,
          expiresAt: true,
          shareFiles: true,
        },
      },
    },
  })
}

function resultIdsOf(page: { resultIds: string }): string[] {
  try {
    const ids: unknown = JSON.parse(page.resultIds)
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

/** Its files that have not arrived, in the order their ids were given. */
async function emptySlots(page: { id: string; resultIds: string }) {
  const order = resultIdsOf(page)
  const slots = await db().fileLink.findMany({
    where: { uploadLinkId: page.id, receivedAt: null },
    select: { id: true, resultId: true },
  })

  return slots.sort(
    (a, b) => order.indexOf(a.resultId) - order.indexOf(b.resultId),
  )
}

export type ArrivedFile = {
  resultId: string
  name: string | null
  mediaType: string
  size: number
  readableUntil: Date
}

/**
 * The files that arrived and can still be used, in the order of their ids:
 * waiting under the link's key, or kept already because the token used
 * their handle.
 */
async function arrivedFiles(
  page: { id: string; vaultId: string; tokenId: string; resultIds: string },
  now: Date,
  /**
   * The key a waiting file's name is sealed under (link-names.ts): from the
   * page's secret, or the slot's wrapped key with the vault's. Without it,
   * waiting files are counted, unnamed.
   */
  slotKey?: (slot: { id: string; wrappedKey: Uint8Array | null }) => Buffer,
): Promise<ArrivedFile[]> {
  const ids = resultIdsOf(page)
  const [waiting, kept] = await Promise.all([
    db().fileLink.findMany({
      where: {
        uploadLinkId: page.id,
        receivedAt: { not: null },
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        resultId: true,
        plainName: true,
        sealedName: true,
        wrappedKey: true,
        mediaType: true,
        length: true,
        expiresAt: true,
      },
    }),
    db().toolResult.findMany({
      where: {
        vaultId: page.vaultId,
        tokenId: page.tokenId,
        id: { in: ids },
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        name: true,
        mediaType: true,
        length: true,
        expiresAt: true,
      },
    }),
  ])
  const byId = new Map<string, ArrivedFile>()

  for (const row of waiting) {
    byId.set(row.resultId, {
      resultId: row.resultId,
      name: slotKey ? openLinkName(slotKey(row), row) : null,
      mediaType: row.mediaType,
      size: row.length,
      readableUntil: row.expiresAt,
    })
  }

  for (const row of kept) {
    byId.set(row.id, {
      resultId: row.id,
      name: row.name,
      mediaType: row.mediaType,
      size: row.length,
      readableUntil: row.expiresAt,
    })
  }

  return ids.flatMap((id) => {
    const file = byId.get(id)
    return file ? [file] : []
  })
}

/** Whether it still takes files: not closed, in time, with room left. */
function takesFiles(
  page: { closedAt: Date | null; acceptUntil: Date },
  empty: number,
  now: Date,
): boolean {
  return !page.closedAt && page.acceptUntil > now && empty > 0
}

/** Closes it: no more files, and the room left for them goes. */
async function closePage(pageId: string, now: Date): Promise<void> {
  await db().uploadLink.updateMany({
    where: { id: pageId, closedAt: null },
    data: { closedAt: now },
  })
  await db().fileLink.deleteMany({
    where: { uploadLinkId: pageId, receivedAt: null },
  })
}

export type UploadPageView =
  | { state: "gone" }
  | {
      state: "open" | "closed"
      /** What the files are for, as the assistant said it. */
      purpose: string
      /** The token's name: which assistant asked. */
      assistant: string
      maxFiles: number
      /** Files it still takes; 0 once closed. */
      remaining: number
      acceptUntil: Date
      files: { name: string | null; mediaType: string; size: number }[]
      /** The store and folder the files are saved in too, if any. */
      destination: UploadDestination | null
    }

/** What the upload page shows, read with the link alone. */
export async function uploadPageView(
  secret: string,
  now = new Date(),
): Promise<UploadPageView> {
  const page = await findPage(secret)

  if (!page || !tokenCanUseLinks(page.token, now)) {
    return { state: "gone" }
  }

  let purpose: string
  let destination: UploadDestination | null

  try {
    purpose = decryptString(
      linkKey(secret, page.id),
      Buffer.from(page.purpose),
      purposeAad(page.id),
    )
    destination = openDestination(secret, page)
  } catch {
    return { state: "gone" }
  }

  const [empty, files] = await Promise.all([
    emptySlots(page),
    arrivedFiles(page, now, (slot) => linkKey(secret, slot.id)),
  ])
  const open = takesFiles(page, empty.length, now)

  return {
    state: open ? "open" : "closed",
    purpose,
    assistant: page.assistant
      ? decryptString(
          linkKey(secret, page.id),
          Buffer.from(page.assistant),
          assistantAad(page.id),
        )
      : // A page from before: the name as it was, while it is in plain text.
        (page.token.sealedName ? null : page.token.plainName) || "An assistant",
    maxFiles: page.maxFiles,
    remaining: open ? empty.length : 0,
    acceptUntil: page.acceptUntil,
    files: files.map(({ name, mediaType, size }) => ({
      name,
      mediaType,
      size,
    })),
    destination,
  }
}

const CLOSED: LinkRefusal = {
  ok: false,
  status: 410,
  message:
    "This link no longer takes files. Ask the assistant for a new one if you have more.",
}

const FULL: LinkRefusal = {
  ok: false,
  status: 409,
  message:
    "This link has taken as many files as it was made for. Ask the assistant for a new one if you have more.",
}

export type PageUpload = {
  ok: true
  resultId: string
  name: string | null
  mediaType: string
  size: number
  /** Whether it takes more files. */
  open: boolean
  remaining: number
  /** Until when it takes them. */
  until: Date
}

/**
 * Takes one file sent to an upload page, as the request's body, into one of
 * the page's empty places. Null when no upload link has that secret (it may
 * be a file link's).
 */
export async function uploadToPage(
  secret: string,
  body: AsyncIterable<Uint8Array> | null,
  {
    contentType,
    contentLength,
    name: sentName,
  }: {
    contentType: string | null
    contentLength: number | null
    name: string | null
  },
  now = new Date(),
): Promise<PageUpload | LinkRefusal | null> {
  const started = Date.now()
  const page = await findPage(secret)

  if (!page) {
    return null
  }

  if (!tokenCanUseLinks(page.token, now)) {
    return GONE
  }

  const log = (ok: boolean) => logUse(page, "upload_link/upload", ok, started)
  const empty = await emptySlots(page)

  if (page.closedAt || page.acceptUntil <= now) {
    await log(false)
    return CLOSED
  }

  if (empty.length === 0) {
    await log(false)
    return FULL
  }

  const read = await readSentFile(body, { contentType, contentLength })

  if (!read.ok) {
    if (read.status === 415) {
      return read
    }

    await log(false)
    return read.status === 413
      ? { ...read, message: read.message.replace("The owner can", "You can") }
      : read
  }

  const { bytes } = read
  const name = cleanFileName(sentName)
  const mediaType = sentMediaType({ asked: "", contentType, name, bytes })
  const readableUntil = new Date(now.getTime() + RESULT_TTL_MS)
  let taken: { id: string; resultId: string } | null = null

  // Another file may arrive at the same moment: each takes a place of its
  // own, and once none is left, the file is refused.
  for (const slot of empty) {
    const { count } = await db().fileLink.updateMany({
      where: { id: slot.id, receivedAt: null },
      data: {
        receivedAt: now,
        uses: 1,
        sealedName: sealLinkName(linkKey(secret, slot.id), slot.id, name),
        length: bytes.length,
        mediaType,
        ciphertext: asBytes(
          encrypt(linkKey(secret, slot.id), bytes, fileAad(slot.id)),
        ),
        expiresAt: readableUntil,
      },
    })

    if (count === 1) {
      taken = slot
      break
    }
  }

  if (!taken) {
    await log(false)
    return FULL
  }

  const until = (await afterFile(page, now)) ?? page.acceptUntil

  const left = await db().fileLink.count({
    where: { uploadLinkId: page.id, receivedAt: null },
  })

  if (left === 0) {
    await closePage(page.id, now)
  }

  await log(true)
  return {
    ok: true,
    resultId: taken.resultId,
    name,
    mediaType,
    size: bytes.length,
    open: left > 0,
    remaining: left,
    until,
  }
}

/**
 * The first file starts the last quarter of an hour: the page takes files
 * until then, and its empty places last as long.
 */
async function afterFile(page: PageRow, now: Date): Promise<Date | null> {
  if (page.firstAt) {
    return null
  }

  const until = new Date(now.getTime() + UPLOAD_AFTER_FIRST_MS)
  const { count } = await db().uploadLink.updateMany({
    where: { id: page.id, firstAt: null },
    data: {
      firstAt: now,
      acceptUntil: until,
      expiresAt: new Date(until.getTime() + RESULT_TTL_MS),
    },
  })

  if (count === 0) {
    return null
  }

  await db().fileLink.updateMany({
    where: { uploadLinkId: page.id, receivedAt: null },
    data: { expiresAt: until },
  })
  return until
}

export type PageDone = { ok: true; files: number }

/** The owner said Done: it takes no more files. Saying it again is fine. */
export async function closeUploadPage(
  secret: string,
  now = new Date(),
): Promise<PageDone | LinkRefusal> {
  const started = Date.now()
  const page = await findPage(secret)

  if (!page || !tokenCanUseLinks(page.token, now)) {
    return GONE
  }

  if (!page.closedAt) {
    await closePage(page.id, now)
    await logUse(page, "upload_link/done", true, started)
  }

  return { ok: true, files: (await arrivedFiles(page, now)).length }
}

export type UploadStatus = {
  id: string
  open: boolean
  maxFiles: number
  remaining: number
  acceptUntil: Date
  files: ArrivedFile[]
}

/** An upload link of the token's, for check_upload; null for none. */
export async function uploadStatus(
  ctx: VaultContext,
  tokenId: string,
  id: string,
  now = new Date(),
): Promise<UploadStatus | null> {
  const page = await db().uploadLink.findFirst({
    where: { id, vaultId: ctx.vaultId, tokenId, expiresAt: { gt: now } },
  })

  if (!page) {
    return null
  }

  const [empty, files] = await Promise.all([
    emptySlots(page),
    arrivedFiles(page, now, (slot) =>
      decrypt(ctx.dek, Buffer.from(slot.wrappedKey!), keyAad(slot.id)),
    ),
  ])
  const open = takesFiles(page, empty.length, now)

  return {
    id: page.id,
    open,
    maxFiles: page.maxFiles,
    remaining: open ? empty.length : 0,
    acceptUntil: page.acceptUntil,
    files,
  }
}

/** Upload links past their day; for the cleanup (their files go as links). */
export async function pruneUploadLinks(now = new Date()): Promise<number> {
  const { count } = await db().uploadLink.deleteMany({
    where: { expiresAt: { lte: now } },
  })

  return count
}
