import type { CallToolResult } from "@modelcontextprotocol/server"

import type { VaultContext } from "./context"
import { db } from "./db"
import { isTextType } from "./media-types"
import { makeRedactor } from "./openapi/redact"
import {
  openResult,
  type OpenedResult,
  type ResultKeeper,
  type ResultOpener,
} from "./tool-results"
import {
  maskJson,
  maskResultWith,
  maskedValue,
  valueMasker,
  type MaskedValue,
} from "./value-masks"
import { scrubResult } from "./wrappers/placeholders"

/**
 * Keeping a pass-only kept result (#149, a part keep named) out of what an
 * assistant reads, when a tool hands its value back (#158): an echo, a
 * search that quotes its query, an API that answers the body it was sent.
 *
 * - In the call that was handed it: the value PCP put in for the handle is
 *   taken out of that call's answer and errors before anything else sees
 *   them, as it is and in the forms JSON encoders write it
 *   (`passOnlyTracker`, from upstream.ts callServerTool).
 * - For as long as the result lives (a day): every answer to the token
 *   (each tool's through the gateway, a program's or a wrapper's
 *   pcp.call, a kept result read back) shows it as [kept: <id>] wherever
 *   its text has it, as it is or lightly reformatted (white space and
 *   separators out, upper case), found as the browser finds a typed secret
 *   (value-masks.ts: keyed hashes and a keyed rolling fingerprint).
 *
 * Nothing new is stored: the values are read from the token's own kept
 * rows inside the request, and only their hashes are held in memory, per
 * result, in this process, until the result expires. A value shorter than
 * MIN_KEPT_MASK_CHARS is not looked for (it would mask ordinary text), nor
 * one longer than MAX_KEPT_MASK_CHARS (a whole kept answer rather than a
 * credential), and only a token's newest MAX_MASKED_RESULTS count.
 */

/** The shortest value looked for, as it is and once normalised. */
export const MIN_KEPT_MASK_CHARS = 8
/** The longest kept value looked for, in characters (or bytes of a file). */
export const MAX_KEPT_MASK_CHARS = 16_384
/** The most of a token's pass-only results looked for, newest first. */
export const MAX_MASKED_RESULTS = 64
/**
 * The longest form of a value the call that was handed it is scrubbed of
 * (passOnlyTracker), in characters: past it, only the masks below.
 */
const MAX_SCRUBBED_CHARS = 65_536
/** The most results whose hashes this process holds at once. */
const MAX_CACHED_RESULTS = 4_096

/** What stands in for a kept value in an answer. */
export function keptLabel(id: string): string {
  return `[kept: ${id}]`
}

/**
 * The forms a kept value is handed to a tool in (result-handles.ts
 * contentOf): its text when it has one, its bytes as base64.
 */
function formsOf(opened: OpenedResult): string[] {
  const forms: string[] = []

  if (opened.kind === "text" || isTextType(opened.mediaType)) {
    try {
      forms.push(opened.text())
    } catch {
      // A file that does not read as text: its base64 only.
    }
  }

  forms.push(opened.bytes().toString("base64"))

  return [...new Set(forms)].filter(
    (form) => form.length >= MIN_KEPT_MASK_CHARS,
  )
}

// ---- In the call that was handed it ----------------------------------------

/**
 * Watches what a call's opener hands out: each pass-only result it opened,
 * to take its value out of that call's answer, errors, and the long texts
 * the call keeps (mail bodies and the like) before anything reads them.
 */
export function passOnlyTracker(open: ResultOpener | undefined) {
  const opened = new Map<string, string[]>()

  const scrubbers = () =>
    [...opened]
      .map(([id, forms]) => ({
        id,
        forms,
        longest: Math.max(...forms.map((form) => form.length)),
      }))
      .filter(({ forms }) => forms.length > 0)
      .sort((a, b) => b.longest - a.longest)

  const scrubText = (text: string): string => {
    let out = text

    for (const { id, forms } of scrubbers()) {
      out = makeRedactor(forms, { replacement: keptLabel(id) }).text(out)
    }

    return out
  }

  return {
    open: open
      ? async (id: string) => {
          const result = await open(id)

          if (result?.passOnly && !opened.has(result.id)) {
            opened.set(
              result.id,
              formsOf(result).filter(
                (form) => form.length <= MAX_SCRUBBED_CHARS,
              ),
            )
          }

          return result
        }
      : undefined,

    /** A long text the call keeps, with the values out (not a pass-only one). */
    keeper(keep: ResultKeeper | undefined): ResultKeeper | undefined {
      return keep
        ? (input) =>
            keep(
              input.passOnly || opened.size === 0
                ? input
                : { ...input, text: scrubText(input.text) },
            )
        : undefined
    },

    scrubText,

    /** The answer with the values out of its texts and structured content. */
    scrub(result: CallToolResult): CallToolResult {
      let out = result

      for (const { id, forms } of scrubbers()) {
        out = scrubResult(out, forms, { replacement: keptLabel(id) })
      }

      return out
    },

    /** The error with the values out of its message; the same error. */
    scrubError(error: unknown): unknown {
      if (opened.size > 0 && error instanceof Error) {
        const message = scrubText(error.message)

        if (message !== error.message) {
          error.message = message
        }
      }

      return error
    },
  }
}

// ---- For the result's life -------------------------------------------------

type Remembered = { tokenId: string; expiresAt: number; values: MaskedValue[] }

const KEY = Symbol.for("pcp.kept-masks")

/** The hashes of each result's value this process worked out, by id. */
function remembered(): Map<string, Remembered> {
  const holder = globalThis as unknown as Record<
    symbol,
    Map<string, Remembered>
  >
  holder[KEY] ??= new Map()
  return holder[KEY]
}

function remember(id: string, entry: Remembered, now: number): void {
  const cache = remembered()

  if (cache.size >= MAX_CACHED_RESULTS) {
    for (const [key, held] of cache) {
      if (held.expiresAt <= now) cache.delete(key)
    }

    // Still full: the oldest go first.
    for (const key of cache.keys()) {
      if (cache.size < MAX_CACHED_RESULTS) break
      cache.delete(key)
    }
  }

  cache.set(id, entry)
}

/** Forgets what this process worked out (tests). */
export function forgetKeptMasks(): void {
  remembered().clear()
}

/**
 * What masks a text with the token's live pass-only results, each as
 * [kept: <id>]; null when it has none. One query on the token's rows; a
 * result's value is opened only the first time this process sees it.
 */
export async function keptMasker(
  ctx: VaultContext,
  tokenId: string,
  now = new Date(),
): Promise<((text: string) => string) | null> {
  const rows = await db().toolResult.findMany({
    where: {
      vaultId: ctx.vaultId,
      tokenId,
      passOnly: true,
      expiresAt: { gt: now },
      length: { lte: MAX_KEPT_MASK_CHARS },
    },
    select: { id: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_MASKED_RESULTS,
  })

  if (rows.length === 0) {
    return null
  }

  const cache = remembered()
  const values: MaskedValue[] = []

  for (const row of rows) {
    let held = cache.get(row.id)

    if (!held || held.tokenId !== tokenId) {
      const opened = await openResult(ctx, { tokenId, id: row.id }, now)

      held = {
        tokenId,
        expiresAt: row.expiresAt.getTime(),
        values: opened
          ? formsOf(opened)
              .filter((form) => form.length <= MAX_KEPT_MASK_CHARS * 2)
              .map((form) => maskedValue(row.id, form))
          : [],
      }
      remember(row.id, held, now.getTime())
    }

    values.push(...held.values)
  }

  return valueMasker(values, {
    render: keptLabel,
    minNormalChars: MIN_KEPT_MASK_CHARS,
  })
}

/** An answer to the token with its live pass-only values masked. */
export async function maskKeptResult(
  ctx: VaultContext,
  tokenId: string,
  result: CallToolResult,
): Promise<CallToolResult> {
  const masker = await keptMasker(ctx, tokenId)
  return masker ? maskResultWith(masker, result) : result
}

/** A text for the token with its live pass-only values masked. */
export async function maskKeptText(
  ctx: VaultContext,
  tokenId: string,
  text: string,
): Promise<string> {
  const masker = await keptMasker(ctx, tokenId)
  return masker ? masker(text) : text
}

/** Every string of a value for the token (keys too), masked. */
export async function maskKeptJson(
  ctx: VaultContext,
  tokenId: string,
  value: unknown,
): Promise<unknown> {
  const masker = await keptMasker(ctx, tokenId)
  return masker ? maskJson(masker, value) : value
}

/** An error for the token with its message masked; the same error. */
export async function maskKeptError(
  ctx: VaultContext,
  tokenId: string,
  error: unknown,
): Promise<unknown> {
  if (error instanceof Error && error.message) {
    const masker = await keptMasker(ctx, tokenId)
    const message = masker ? masker(error.message) : error.message

    if (message !== error.message) {
      error.message = message
    }
  }

  return error
}
