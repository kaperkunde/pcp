import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { MAX_INSTRUCTIONS_CHARS } from "./constants"
import { currentTemplate, templateText } from "./instructions-defaults"
import { hasConflictMarkers, mergeLines, type LineMerge } from "./line-merge"
import { hiddenCharacter, withoutPresentation } from "./memories"

/**
 * The owner's instructions for one assistant: text kept on its token,
 * encrypted under the vault's key with "api_token:<id>" as associated data,
 * and given to the assistant at the start of every conversation (the
 * gateway's instructions, and read_memory every for a token that keeps
 * memories, since clients cut instructions short).
 *
 * A new token gets a copy of PCP's suggested instructions
 * (instructions-defaults.ts) and the version it copied. A token made before
 * there were any has none: its page shows the suggestion as not set yet,
 * and it gets nothing until the owner saves. When a newer suggestion ships,
 * the tokens that follow an older one are a notice for the owner, who keeps
 * theirs, takes PCP's, or merges the two.
 */

function aad(tokenId: string): string {
  return `api_token:${tokenId}`
}

/** Instructions as the column holds them. */
export function sealInstructions(
  ctx: VaultContext,
  tokenId: string,
  text: string,
): Uint8Array<ArrayBuffer> {
  return asBytes(encryptString(ctx.dek, text, aad(tokenId)))
}

/** A token's instructions, or null when it has none or they do not open. */
export function openInstructions(
  dek: Buffer,
  tokenId: string,
  sealed: Uint8Array | null,
): string | null {
  if (!sealed) {
    return null
  }

  try {
    return decryptString(dek, Buffer.from(sealed), aad(tokenId))
  } catch {
    console.error("[instructions] a token's instructions did not decrypt", {
      tokenId,
    })
    return null
  }
}

/** The columns of a new token: PCP's suggestion, copied. */
export function newTokenInstructions(ctx: VaultContext, tokenId: string) {
  const template = currentTemplate()

  return {
    instructions: sealInstructions(ctx, tokenId, template.text),
    instructionsBase: template.version,
  }
}

/** Instructions as the owner typed them, checked; newlines made plain. */
export function checkInstructions(input: string): string {
  const text = withoutPresentation(input.replace(/\r\n?/g, "\n")).trimEnd()

  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    throw invalid(
      `Instructions are at most ${MAX_INSTRUCTIONS_CHARS.toLocaleString("en")} characters, so they fit at the start of a conversation; these have ${text.length.toLocaleString("en")}.`,
    )
  }

  const hidden = hiddenCharacter(text)

  if (hidden) {
    throw invalid(
      `The text has a character that does not show on screen (${hidden}). Take it out: the assistant should read only what you can.`,
    )
  }

  if (hasConflictMarkers(text)) {
    throw invalid(
      "The text still has a place marked for you to settle (the lines from <<<<<<< to >>>>>>>). Keep what you want of each side and take the marker lines out.",
    )
  }

  return text
}

export type TokenInstructions = {
  /** What the editor shows: the token's own, or PCP's suggestion. */
  text: string
  /** Whether the token has instructions of its own, saved. */
  saved: boolean
  /** The version of the suggestion they came from. */
  base: number | null
  /** The suggestion's version now. */
  current: number
  /** They follow an older suggestion than the one PCP has now. */
  outdated: boolean
}

async function tokenRow(ctx: VaultContext, tokenId: string) {
  const row = await db().apiToken.findFirst({
    where: { id: tokenId, vaultId: ctx.vaultId },
    select: {
      id: true,
      name: true,
      revokedAt: true,
      instructions: true,
      instructionsBase: true,
    },
  })

  if (!row) {
    throw notFound("That token")
  }

  return row
}

async function liveRow(ctx: VaultContext, tokenId: string) {
  const row = await tokenRow(ctx, tokenId)

  if (row.revokedAt) {
    throw new PcpError("state", "A revoked token cannot be changed.")
  }

  return row
}

export async function getTokenInstructions(
  ctx: VaultContext,
  tokenId: string,
): Promise<TokenInstructions> {
  const row = await tokenRow(ctx, tokenId)
  const own = openInstructions(ctx.dek, row.id, row.instructions)
  const current = currentTemplate()

  return {
    text: own ?? current.text,
    saved: own !== null,
    base: own !== null ? row.instructionsBase : null,
    current: current.version,
    outdated:
      own !== null &&
      row.instructionsBase !== null &&
      row.instructionsBase < current.version,
  }
}

/**
 * The owner's save in the editor. Text saved for a token that had none
 * starts from the suggestion it showed; otherwise the version it follows
 * stays, so a newer suggestion is still offered. `merged` saves the result
 * of merging with the current suggestion, which it then follows.
 */
export async function saveTokenInstructions(
  ctx: VaultContext,
  tokenId: string,
  input: string,
  { merged = false }: { merged?: boolean } = {},
): Promise<void> {
  const row = await liveRow(ctx, tokenId)
  const text = checkInstructions(input)
  const current = currentTemplate().version

  await db().apiToken.update({
    where: { id: row.id },
    data: {
      instructions: sealInstructions(ctx, row.id, text),
      instructionsBase:
        merged || row.instructions === null
          ? current
          : (row.instructionsBase ?? current),
    },
  })
}

/** "Keep mine": the token's text stays, and follows the current suggestion. */
export async function keepOwnInstructions(
  ctx: VaultContext,
  tokenId: string,
): Promise<void> {
  const row = await liveRow(ctx, tokenId)

  if (row.instructions === null) {
    throw invalid("This token has no instructions of its own to keep.")
  }

  await db().apiToken.update({
    where: { id: row.id },
    data: { instructionsBase: currentTemplate().version },
  })
}

/** "Take PCP's": the current suggestion in place of the token's text. */
export async function takeSuggestedInstructions(
  ctx: VaultContext,
  tokenId: string,
): Promise<void> {
  const row = await liveRow(ctx, tokenId)

  await db().apiToken.update({
    where: { id: row.id },
    data: newTokenInstructions(ctx, row.id),
  })
}

export type InstructionsUpdate = {
  tokenId: string
  tokenName: string
  /** The token's text now. */
  mine: string
  /** PCP's suggestion now. */
  theirs: string
  /** The two merged, with the version the token followed as the base. */
  merge: LineMerge
}

/**
 * The tokens that follow an older suggestion than PCP's now, each with its
 * text and the merge on offer. Revoked tokens are left out: nothing about
 * them changes.
 */
export async function outdatedInstructions(
  ctx: VaultContext,
): Promise<InstructionsUpdate[]> {
  const current = currentTemplate()
  const rows = await db().apiToken.findMany({
    where: {
      vaultId: ctx.vaultId,
      revokedAt: null,
      instructions: { not: null },
      instructionsBase: { lt: current.version },
    },
    select: {
      id: true,
      name: true,
      instructions: true,
      instructionsBase: true,
    },
    orderBy: { createdAt: "asc" },
  })

  return rows.flatMap((row) => {
    const mine = openInstructions(ctx.dek, row.id, row.instructions)

    if (mine === null) {
      return []
    }

    // A base PCP no longer knows merges as if nothing were in common.
    const base = templateText(row.instructionsBase ?? 0) ?? ""

    return [
      {
        tokenId: row.id,
        tokenName: row.name,
        mine,
        theirs: current.text,
        merge: mergeLines(base, mine, current.text),
      },
    ]
  })
}

/** How many tokens follow an older suggestion, without opening any. */
export function countOutdatedInstructions(ctx: VaultContext): Promise<number> {
  return db().apiToken.count({
    where: {
      vaultId: ctx.vaultId,
      revokedAt: null,
      instructions: { not: null },
      instructionsBase: { lt: currentTemplate().version },
    },
  })
}
