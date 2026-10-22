import type { McpServer, Skill } from "@/lib/generated/prisma/client"

import { MAX_PERSONAL_NOTE } from "./constants"
import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { hiddenCharacter } from "./memories"

/**
 * The owner's own note on a server or a skill: a line of their words about
 * this one (which host, what it is for) beside the description its
 * definition carries. Encrypted under the vault's key, written only from the
 * owner's pages, never in a repository document, an export of a definition
 * or anything else shared, and shown to assistants that see the server or
 * skill as the owner's note ("Owner's note: …"). The owner wrote it, so it
 * may stand in the gateway's instructions.
 */

export type NoteKind = "server" | "skill"

function noteAad(kind: NoteKind, id: string): string {
  return kind === "server" ? `mcp_server:${id}` : `skill:${id}:note`
}

/**
 * A note as it is saved: trimmed, at most MAX_PERSONAL_NOTE characters, on
 * one line, with nothing in it that does not show on screen. Empty is none.
 */
export function checkPersonalNote(
  input: string | null | undefined,
): string | null {
  const note = (input ?? "").trim()

  if (!note) {
    return null
  }

  if (/[\r\n\u2028\u2029]/u.test(note)) {
    throw invalid("Keep the note on one line.")
  }

  const hidden = note.includes("\t") ? "U+0009" : hiddenCharacter(note)

  if (hidden) {
    throw invalid(
      `The note holds a character that does not show on screen (${hidden}). Take it out.`,
    )
  }

  if ([...note].length > MAX_PERSONAL_NOTE) {
    throw invalid(
      `Keep the note to ${MAX_PERSONAL_NOTE} characters; it has ${[...note].length}.`,
    )
  }

  return note
}

function readNote(
  ctx: VaultContext,
  kind: NoteKind,
  row: { id: string; personalNote: Uint8Array | null },
): string | null {
  if (!row.personalNote) {
    return null
  }

  try {
    return decryptString(
      ctx.dek,
      Buffer.from(row.personalNote),
      noteAad(kind, row.id),
    )
  } catch {
    // A note that does not open is not worth failing a request for.
    return null
  }
}

/** A server's note, opened. */
export function readServerNote(
  ctx: VaultContext,
  row: Pick<McpServer, "id" | "personalNote">,
): string | null {
  return readNote(ctx, "server", row)
}

/** A skill's note, opened. */
export function readSkillNote(
  ctx: VaultContext,
  row: Pick<Skill, "id" | "personalNote">,
): string | null {
  return readNote(ctx, "skill", row)
}

function sealNote(
  ctx: VaultContext,
  kind: NoteKind,
  id: string,
  note: string | null,
) {
  return note === null
    ? null
    : asBytes(encryptString(ctx.dek, note, noteAad(kind, id)))
}

/**
 * The owner's note on a server or a skill, written or (empty) taken away.
 * Only the owner's own pages call this. It is what the note now says.
 */
export async function setPersonalNote(
  ctx: VaultContext,
  kind: NoteKind,
  id: string,
  input: string | null,
): Promise<string | null> {
  const note = checkPersonalNote(input)
  const personalNote = sealNote(ctx, kind, id, note)

  const { count } =
    kind === "server"
      ? await db().mcpServer.updateMany({
          where: { id, vaultId: ctx.vaultId },
          data: { personalNote },
        })
      : await db().skill.updateMany({
          where: { id, vaultId: ctx.vaultId },
          data: { personalNote },
        })

  if (count === 0) {
    throw notFound(kind === "server" ? "That server" : "That skill")
  }

  return note
}

/** A note cut to fit a line of the gateway's instructions. */
export function clipNote(note: string, max = 120): string {
  const chars = [...note]
  return chars.length <= max
    ? note
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
}

/** "Owner's note: …", the way assistants are shown one, or empty. */
export function ownerNoteLine(note: string | null | undefined): string {
  return note ? `Owner's note: ${note}` : ""
}
