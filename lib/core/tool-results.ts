import type { CallToolResult } from "@modelcontextprotocol/server"

import type { VaultContext } from "./context"
import {
  asBytes,
  decrypt,
  decryptString,
  encrypt,
  encryptString,
} from "./crypto"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import { bareType, charsetOf, decodeText, isTextType } from "./media-types"
import { loadResourceLimits, resourceLimits } from "./resources/state"

/**
 * Answers too long to hand to an assistant in one piece, and files that move
 * between tools. A tool's text, or a file's bytes, is kept whole for a day,
 * encrypted under the vault's data key. A long answer gives the assistant its
 * first page with a notice naming the result; read_result reads the rest a
 * slice at a time, and a handle ({"$result": id}) stands for the content in
 * the arguments of any later call, so it never has to pass through the
 * assistant. Only the token whose call produced a result can read or use
 * it, and nothing kept here is ever logged.
 *
 * Offsets and lengths of a text count UTF-16 code units, as JavaScript
 * strings do; those of bytes count bytes.
 */

/** The most an answer, or one read_result slice, carries. */
export const RESULT_PAGE_CHARS = 60_000
/*
 * The most kept of one text (past it the rest is dropped and said so) and
 * of one file (a larger one is refused, not cut), and what one token's
 * results hold together, follow the machine and the owner's settings
 * (lib/core/resources/): `resourceLimits()`.
 */
/**
 * Per token: the oldest results go first once this or the size limit is
 * passed. Texts count their characters and files their bytes. The row cap
 * allows for an answer that makes a handle of each of many fields.
 */
export const MAX_KEPT_RESULTS_PER_TOKEN = 300
export const RESULT_TTL_MS = 24 * 60 * 60_000
const MAX_NAME_CHARS = 255
const MAX_MEDIA_TYPE_CHARS = 200

/** Any media type; parameters (a charset) are allowed. */
export type ResultMediaType = string
export type ResultKind = "text" | "bytes"

export type KeptResult = {
  id: string
  kind: ResultKind
  mediaType: string
  name: string | null
  /** What was kept: characters of a text, bytes of a file. */
  length: number
  expiresAt: Date
  /** Characters past the most kept of one text that were not kept. */
  dropped: number
}

/** Keeps one long text for the token a call was made with. */
export type ResultKeeper = (input: {
  text: string
  mediaType: ResultMediaType
  name?: string | null
  serverId: string | null
  toolName: string
}) => Promise<KeptResult>

/** Keeps one file's bytes for the token a call was made with. */
export type BytesKeeper = (input: {
  bytes: Buffer
  mediaType: ResultMediaType
  name: string | null
  serverId: string | null
  toolName: string
}) => Promise<KeptResult>

export type Keepers = { text: ResultKeeper; bytes: BytesKeeper }

function aad(id: string): string {
  return `tool_result:${id}`
}

/** A file name without control characters or a path, or null. */
function cleanName(name: string | null | undefined): string | null {
  const clean = (name ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .split(/[\\/]/)
    .pop()!
    .trim()
    .slice(0, MAX_NAME_CHARS)

  return clean === "" ? null : clean
}

/** An index that does not split a surrogate pair. */
function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return Math.max(0, Math.min(index, text.length))
  }

  const before = text.charCodeAt(index - 1)
  return before >= 0xd800 && before <= 0xdbff ? index - 1 : index
}

async function store(
  ctx: VaultContext,
  input: {
    tokenId: string
    serverId: string | null
    toolName: string
    kind: ResultKind
    mediaType: string
    name: string | null
    length: number
    ciphertext: (id: string) => Buffer
  },
  now: Date,
): Promise<{ id: string; expiresAt: Date }> {
  const id = newId()
  const expiresAt = new Date(now.getTime() + RESULT_TTL_MS)

  await db().toolResult.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      serverId: input.serverId,
      toolName: input.toolName.slice(0, 200),
      kind: input.kind,
      name: input.name,
      mediaType: input.mediaType.slice(0, MAX_MEDIA_TYPE_CHARS),
      length: input.length,
      ciphertext: asBytes(input.ciphertext(id)),
      createdAt: now,
      expiresAt,
    },
  })

  await enforceTokenLimits(input.tokenId, now)

  return { id, expiresAt }
}

export async function keepResult(
  ctx: VaultContext,
  input: {
    tokenId: string
    serverId: string | null
    toolName: string
    text: string
    mediaType: ResultMediaType
    name?: string | null
  },
  now = new Date(),
): Promise<KeptResult> {
  const { textChars } = await loadResourceLimits()
  const end = safeCut(input.text, textChars)
  const text = input.text.slice(0, end)
  const name = cleanName(input.name)
  const mediaType = input.mediaType.slice(0, MAX_MEDIA_TYPE_CHARS)
  const { id, expiresAt } = await store(
    ctx,
    {
      tokenId: input.tokenId,
      serverId: input.serverId,
      toolName: input.toolName,
      kind: "text",
      mediaType,
      name,
      length: text.length,
      ciphertext: (id) => encryptString(ctx.dek, text, aad(id)),
    },
    now,
  )

  return {
    id,
    kind: "text",
    mediaType,
    name,
    length: text.length,
    expiresAt,
    dropped: input.text.length - text.length,
  }
}

/**
 * Keeps a file's bytes. One over the largest file (resourceLimits()) is
 * refused, not cut: half a PDF is no use to anyone.
 */
export async function keepBytes(
  ctx: VaultContext,
  input: {
    tokenId: string
    serverId: string | null
    toolName: string
    bytes: Buffer
    mediaType: ResultMediaType
    name: string | null
  },
  now = new Date(),
): Promise<KeptResult> {
  const { fileBytes } = await loadResourceLimits()

  if (input.bytes.length > fileBytes) {
    throw invalid(
      `That is ${NUMBER.format(input.bytes.length)} bytes, more than PCP keeps of one file (${NUMBER.format(fileBytes)}). The owner can raise that in PCP's settings, under Resources.`,
    )
  }

  const name = cleanName(input.name)
  const mediaType = input.mediaType.slice(0, MAX_MEDIA_TYPE_CHARS)
  const { id, expiresAt } = await store(
    ctx,
    {
      tokenId: input.tokenId,
      serverId: input.serverId,
      toolName: input.toolName,
      kind: "bytes",
      mediaType,
      name,
      length: input.bytes.length,
      ciphertext: (id) => encrypt(ctx.dek, input.bytes, aad(id)),
    },
    now,
  )

  return {
    id,
    kind: "bytes",
    mediaType,
    name,
    length: input.bytes.length,
    expiresAt,
    dropped: 0,
  }
}

/** Drops expired results, then the token's oldest past its caps. */
async function enforceTokenLimits(tokenId: string, now: Date): Promise<void> {
  await db().toolResult.deleteMany({
    where: { tokenId, expiresAt: { lte: now } },
  })

  const rows = await db().toolResult.findMany({
    where: { tokenId },
    select: { id: true, length: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  })
  const { keptBytesPerToken } = resourceLimits()
  const over: string[] = []
  let total = 0

  rows.forEach((row, index) => {
    total += row.length

    if (
      index >= MAX_KEPT_RESULTS_PER_TOKEN ||
      (index > 0 && total > keptBytesPerToken)
    ) {
      over.push(row.id)
    }
  })

  if (over.length > 0) {
    await db().toolResult.deleteMany({ where: { id: { in: over } } })
  }
}

export function resultKeeper(ctx: VaultContext, tokenId: string): ResultKeeper {
  return (input) => keepResult(ctx, { tokenId, ...input })
}

export function resultKeepers(ctx: VaultContext, tokenId: string): Keepers {
  return {
    text: resultKeeper(ctx, tokenId),
    bytes: (input) => keepBytes(ctx, { tokenId, ...input }),
  }
}

/**
 * What an answer shows in place of a kept value, and what a later call names
 * to use it: {"$result": id, ...}. Text carries its length and the start of
 * it (`preview`, when the caller has one); a file carries its size.
 */
export type ResultHandle = {
  $result: string
  type: string
  length?: number
  size?: number
  name?: string
  preview?: string
  readableUntil: string
}

export function handleOf(kept: KeptResult, preview?: string): ResultHandle {
  return {
    $result: kept.id,
    type: kept.mediaType,
    ...(kept.kind === "bytes"
      ? { size: kept.length }
      : { length: kept.length }),
    ...(kept.name ? { name: kept.name } : {}),
    ...(preview ? { preview } : {}),
    readableUntil: kept.expiresAt.toISOString(),
  }
}

/** A kept result, opened for use as an argument or an attachment. */
export type OpenedResult = {
  id: string
  kind: ResultKind
  mediaType: string
  name: string | null
  /** Characters of a text, bytes of a file. */
  length: number
  /** The text; a file that is not a text type refuses. */
  text(): string
  /** The bytes; a text as UTF-8. */
  bytes(): Buffer
}

export type ResultOpener = (id: string) => Promise<OpenedResult | null>

/**
 * A kept result for the token that kept it; another token's, another
 * vault's, an expired one and an unknown id are all null.
 */
export async function openResult(
  ctx: VaultContext,
  input: { tokenId: string; id: string },
  now = new Date(),
): Promise<OpenedResult | null> {
  // An id left out would match every row to Prisma: none is none.
  if (typeof input.id !== "string" || input.id === "") {
    return null
  }

  const row = await db().toolResult.findFirst({
    where: {
      id: input.id,
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      expiresAt: { gt: now },
    },
  })

  if (!row) {
    return null
  }

  const base = {
    id: row.id,
    kind: row.kind as ResultKind,
    mediaType: row.mediaType,
    name: row.name,
    length: row.length,
  }

  if (row.kind === "bytes") {
    const bytes = decrypt(ctx.dek, Buffer.from(row.ciphertext), aad(row.id))

    return {
      ...base,
      text: () => {
        if (!isTextType(row.mediaType)) {
          throw invalid(
            `Result ${row.id} is ${bareType(row.mediaType)}, not text: pass it as base64 instead.`,
          )
        }

        return decodeText(bytes, charsetOf(row.mediaType))
      },
      bytes: () => bytes,
    }
  }

  const text = decryptString(ctx.dek, Buffer.from(row.ciphertext), aad(row.id))

  return { ...base, text: () => text, bytes: () => Buffer.from(text, "utf8") }
}

export function resultOpener(ctx: VaultContext, tokenId: string): ResultOpener {
  return (id) => openResult(ctx, { tokenId, id })
}

export type ResultInfo =
  | { id: string; found: false }
  | {
      id: string
      found: true
      kind: ResultKind
      mediaType: string
      name: string | null
      length: number
      serverId: string | null
      toolName: string
      createdAt: Date
      expiresAt: Date
    }

/** What is known of each id for the token, in the order given; no content. */
export async function describeResults(
  ctx: VaultContext,
  tokenId: string,
  ids: string[],
  now = new Date(),
): Promise<ResultInfo[]> {
  if (ids.length === 0) {
    return []
  }

  const rows = await db().toolResult.findMany({
    where: {
      id: { in: ids },
      vaultId: ctx.vaultId,
      tokenId,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      kind: true,
      mediaType: true,
      name: true,
      length: true,
      serverId: true,
      toolName: true,
      createdAt: true,
      expiresAt: true,
    },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))

  return ids.map((id): ResultInfo => {
    const row = byId.get(id)

    return row
      ? { ...row, found: true, kind: row.kind as ResultKind }
      : { id, found: false }
  })
}

export type ResultSlice = {
  id: string
  kind: ResultKind
  name: string | null
  /** Where the slice starts. */
  offset: number
  text: string
  total: number
  mediaType: string
  expiresAt: Date
  /** With find: where the text was found, or null when it was not. */
  foundAt: number | null
  /** A file that is not text: no slice is given, only what it is. */
  binary: boolean
}

/**
 * One slice of a kept result. Another token's result, another vault's, and
 * an expired one all read as not found. A file of a text type is decoded and
 * read like a text; any other file is described, not shown.
 */
export async function readResult(
  ctx: VaultContext,
  input: {
    tokenId: string
    id: string
    offset?: number
    length?: number
    find?: string
  },
  now = new Date(),
): Promise<ResultSlice> {
  const opened = await openResult(ctx, input, now)

  if (!opened) {
    throw notFound("That result")
  }

  const row = await db().toolResult.findFirst({
    where: { id: opened.id },
    select: { expiresAt: true },
  })
  const expiresAt = row?.expiresAt ?? now
  const common = {
    id: opened.id,
    kind: opened.kind,
    name: opened.name,
    mediaType: opened.mediaType,
    expiresAt,
  }

  if (opened.kind === "bytes" && !isTextType(opened.mediaType)) {
    return {
      ...common,
      offset: 0,
      text: "",
      total: opened.length,
      foundAt: null,
      binary: true,
    }
  }

  const text = opened.text()
  const length = Math.min(
    Math.max(1, Math.floor(input.length ?? RESULT_PAGE_CHARS)),
    RESULT_PAGE_CHARS,
  )
  let start = Math.min(Math.max(0, Math.floor(input.offset ?? 0)), text.length)
  let foundAt: number | null = null

  if (input.find !== undefined) {
    const at = text.indexOf(input.find, start)

    if (at === -1) {
      return {
        ...common,
        offset: start,
        text: "",
        total: text.length,
        foundAt: null,
        binary: false,
      }
    }

    foundAt = at
    start = at
  }

  const end = safeCut(text, start + length)

  return {
    ...common,
    offset: start,
    text: text.slice(start, end > start ? end : start + length),
    total: text.length,
    foundAt,
    binary: false,
  }
}

/** Results past their day; run at boot beside the other prunes. */
export async function pruneToolResults(now = new Date()): Promise<number> {
  const { count } = await db().toolResult.deleteMany({
    where: { expiresAt: { lte: now } },
  })

  return count
}

const NUMBER = new Intl.NumberFormat("en-US")

/** The line that follows a long answer's shortened text. */
export function resultNotice(kept: KeptResult): string {
  const dropped =
    kept.dropped > 0
      ? ` Only its first ${NUMBER.format(kept.length)} characters were kept; the last ${NUMBER.format(kept.dropped)} are gone.`
      : ""

  return `… (PCP kept the whole answer: ${NUMBER.format(kept.length)} characters as result ${kept.id}, readable until ${kept.expiresAt.toISOString()}. What is above is shortened; call read_result with that id to read the whole of it, from any offset or from where a text appears.${dropped})`
}

/** The notices in a result's text, so a shortened copy can keep them. */
export function resultNotices(texts: string[]): string[] {
  return texts.flatMap(
    (text) =>
      text.match(
        /… \(PCP kept the whole answer: [^\n]*\)|PCP kept \d+ values? of this answer as results[^\n]*/g,
      ) ?? [],
  )
}

function mediaTypeOf(text: string): ResultMediaType {
  const start = text.trimStart()[0]

  if (start === "{" || start === "[") {
    try {
      JSON.parse(text)
      return "application/json"
    } catch {
      // Text that only looks like JSON.
    }
  }

  return "text/plain"
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
}

function fits(result: CallToolResult): boolean {
  return (
    (result.content ?? []).every(
      (block) =>
        block.type !== "text" || block.text.length <= RESULT_PAGE_CHARS,
    ) &&
    (result.structuredContent === undefined ||
      (JSON.stringify(result.structuredContent)?.length ?? 0) <=
        RESULT_PAGE_CHARS)
  )
}

/**
 * An upstream answer as an assistant receives it: `shown`, already shaped to
 * fit (lib/core/answers.ts previews or cuts what is too long). When that
 * left something out, the whole answer (`whole`, shaped the same way but not
 * cut) is kept for the token and a notice after `shown` names it, so the
 * assistant can read the rest with read_result instead of losing it.
 */
export async function keepWholeAnswer(
  {
    raw,
    shown,
    whole,
  }: {
    /** What the upstream answered. */
    raw: CallToolResult
    shown: CallToolResult
    /** The answer shaped as asked, but not cut: made only when needed. */
    whole: () => CallToolResult
  },
  keep: ResultKeeper,
  context: { serverId: string | null; toolName: string },
): Promise<CallToolResult> {
  if (fits(raw)) {
    return shown
  }

  const text = textOf(whole())

  if (text.length <= RESULT_PAGE_CHARS) {
    return shown
  }

  const kept = await keep({ ...context, text, mediaType: mediaTypeOf(text) })

  return {
    ...shown,
    content: [
      ...(shown.content ?? []),
      { type: "text", text: resultNotice(kept) },
    ],
  }
}
