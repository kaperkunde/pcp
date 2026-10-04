import type { CallToolResult } from "@modelcontextprotocol/server"

import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import { notFound } from "./errors"
import { newId } from "./ids"

/**
 * Answers too long to hand to an assistant in one piece. A tool's text is
 * kept whole for a day, encrypted under the vault's data key, and the
 * assistant gets the first page with a notice naming the result; read_result
 * reads the rest a slice at a time. Only the token whose call produced a
 * result can read it, and nothing kept here is ever logged.
 *
 * Offsets and lengths count UTF-16 code units, as JavaScript strings do.
 */

/** The most an answer, or one read_result slice, carries. */
export const RESULT_PAGE_CHARS = 60_000
/** The first page of a long answer: room is left for the notice. */
export const RESULT_FIRST_PAGE_CHARS = 50_000
/** The most kept of one answer; past it the rest is dropped and said so. */
export const MAX_KEPT_RESULT_CHARS = 4_000_000
/** Per token: the oldest results go first once either is passed. */
export const MAX_KEPT_RESULTS_PER_TOKEN = 100
export const MAX_KEPT_CHARS_PER_TOKEN = 50_000_000
export const RESULT_TTL_MS = 24 * 60 * 60_000

export type ResultMediaType = "text/plain" | "application/json"

export type KeptResult = {
  id: string
  /** What was kept, in characters. */
  length: number
  expiresAt: Date
  /** Characters past MAX_KEPT_RESULT_CHARS that were not kept. */
  dropped: number
}

/** Keeps one long text for the token a call was made with. */
export type ResultKeeper = (input: {
  text: string
  mediaType: ResultMediaType
  serverId: string | null
  toolName: string
}) => Promise<KeptResult>

function aad(id: string): string {
  return `tool_result:${id}`
}

/** An index that does not split a surrogate pair. */
function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return Math.max(0, Math.min(index, text.length))
  }

  const before = text.charCodeAt(index - 1)
  return before >= 0xd800 && before <= 0xdbff ? index - 1 : index
}

export async function keepResult(
  ctx: VaultContext,
  input: {
    tokenId: string
    serverId: string | null
    toolName: string
    text: string
    mediaType: ResultMediaType
  },
  now = new Date(),
): Promise<KeptResult> {
  const end = safeCut(input.text, MAX_KEPT_RESULT_CHARS)
  const text = input.text.slice(0, end)
  const id = newId()
  const expiresAt = new Date(now.getTime() + RESULT_TTL_MS)

  await db().toolResult.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      serverId: input.serverId,
      toolName: input.toolName.slice(0, 200),
      mediaType: input.mediaType,
      length: text.length,
      ciphertext: asBytes(encryptString(ctx.dek, text, aad(id))),
      createdAt: now,
      expiresAt,
    },
  })

  await enforceTokenLimits(input.tokenId, now)

  return {
    id,
    length: text.length,
    expiresAt,
    dropped: input.text.length - text.length,
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
  const over: string[] = []
  let total = 0

  rows.forEach((row, index) => {
    total += row.length

    if (
      index >= MAX_KEPT_RESULTS_PER_TOKEN ||
      (index > 0 && total > MAX_KEPT_CHARS_PER_TOKEN)
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

export type ResultSlice = {
  id: string
  /** Where the slice starts. */
  offset: number
  text: string
  total: number
  mediaType: string
  expiresAt: Date
  /** With find: where the text was found, or null when it was not. */
  foundAt: number | null
}

/**
 * One slice of a kept result. Another token's result, another vault's, and
 * an expired one all read as not found.
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
  const row = await db().toolResult.findFirst({
    where: {
      id: input.id,
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      expiresAt: { gt: now },
    },
  })

  if (!row) {
    throw notFound("That result")
  }

  const text = decryptString(ctx.dek, Buffer.from(row.ciphertext), aad(row.id))
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
        id: row.id,
        offset: start,
        text: "",
        total: text.length,
        mediaType: row.mediaType,
        expiresAt: row.expiresAt,
        foundAt: null,
      }
    }

    foundAt = at
    start = at
  }

  const end = safeCut(text, start + length)

  return {
    id: row.id,
    offset: start,
    text: text.slice(start, end > start ? end : start + length),
    total: text.length,
    mediaType: row.mediaType,
    expiresAt: row.expiresAt,
    foundAt,
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

/** The line that follows the first page of a long answer. */
export function resultNotice(kept: KeptResult, shown: number): string {
  const dropped =
    kept.dropped > 0
      ? ` Only its first ${NUMBER.format(kept.length)} characters were kept; the last ${NUMBER.format(kept.dropped)} are gone.`
      : ""

  return `… (PCP kept the whole answer: ${NUMBER.format(kept.length)} characters as result ${kept.id}, readable until ${kept.expiresAt.toISOString()}. The first ${NUMBER.format(shown)} are above; call read_result with that id and an offset to read the rest.${dropped})`
}

/** The notices in a result's text, so a shortened copy can keep them. */
export function resultNotices(texts: string[]): string[] {
  return texts.flatMap(
    (text) => text.match(/… \(PCP kept the whole answer: [^\n]*\)/g) ?? [],
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

async function firstPage(
  text: string,
  keep: ResultKeeper,
  context: { serverId: string | null; toolName: string },
): Promise<string> {
  const kept = await keep({ ...context, text, mediaType: mediaTypeOf(text) })
  const shown = safeCut(text, RESULT_FIRST_PAGE_CHARS)

  return `${text.slice(0, shown)}\n${resultNotice(kept, shown)}`
}

/**
 * An upstream result as an assistant receives it: each text block longer
 * than a page is kept whole and replaced with its first page and a notice.
 * Structured content too long for a page is left out (the text carries the
 * same answer), and kept on its own when no text block was.
 */
export async function pageResult(
  result: CallToolResult,
  keep: ResultKeeper,
  context: { serverId: string | null; toolName: string },
): Promise<CallToolResult> {
  let paged = false
  const content: CallToolResult["content"] = []

  for (const block of result.content) {
    if (block.type === "text" && block.text.length > RESULT_PAGE_CHARS) {
      paged = true
      content.push({
        ...block,
        text: await firstPage(block.text, keep, context),
      })
    } else {
      content.push(block)
    }
  }

  let structuredContent = result.structuredContent

  if (structuredContent) {
    const json = JSON.stringify(structuredContent)

    if (json.length > RESULT_PAGE_CHARS) {
      structuredContent = undefined

      if (!paged) {
        content.push({
          type: "text",
          text: await firstPage(json, keep, context),
        })
      }
    }
  }

  return {
    content,
    ...(result.isError ? { isError: true } : {}),
    ...(structuredContent ? { structuredContent } : {}),
  }
}
