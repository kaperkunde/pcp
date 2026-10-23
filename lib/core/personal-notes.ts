import type { McpServer, Skill } from "@/lib/generated/prisma/client"

import { MAX_PERSONAL_NOTE } from "./constants"
import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString, sha256Hex } from "./crypto"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { hiddenCharacter } from "./memories"

/**
 * The owner's own note on a server or a skill: a line of their words about
 * this one (which host, what it is for) beside the description its
 * definition carries. Encrypted under the vault's key, written from the
 * owner's pages or, as an assistant proposed it, once the owner read it
 * whole and agreed; never in a repository document, an export of a definition
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
 * Only the owner's own pages call this, and what they agreed to on PCP's
 * page (an assistant's proposal, applyNoteChange; a new server's note). It
 * is what the note now says.
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

// ---- An assistant's proposal ------------------------------------------------

/**
 * A note an assistant proposed for a server or a skill it sees: the
 * owner's words once they agree, so they read it whole first, and it is
 * written only as they read it, over the note they had then (`basis`).
 */
export type NoteChangeAsk = {
  target: NoteKind
  id: string
  /** The server's or skill's name, for the lines. */
  name: string
  /** The tool it was asked through. */
  via: "update_endpoint" | "update_wrapper" | "memory"
  /** The note it gets; null takes the note away. */
  note: string | null
  /** The note when the owner was asked, as a hash. */
  basis: string
  shown: { title: string; lines: string[]; warning: string | null }
}

function noteBasis(note: string | null): string {
  return sha256Hex(note ?? "")
}

/**
 * What the owner is asked about a note an assistant proposed, checked as a
 * note is (one line, at most MAX_PERSONAL_NOTE characters, nothing hidden).
 * Nothing is written. `label` is how the owner knows the item: a server's
 * name and short name, a skill's path.
 */
export function proposeNote(
  ctx: VaultContext,
  target: {
    kind: NoteKind
    row: { id: string; personalNote: Uint8Array | null }
    name: string
    label: string
  },
  input: string,
  via: NoteChangeAsk["via"],
): NoteChangeAsk {
  const note = checkPersonalNote(input)
  const current = readNote(ctx, target.kind, target.row)

  if (note === current) {
    throw invalid(
      note === null
        ? `${target.name} has no note to take away.`
        : `That is the note ${target.name} has already.`,
    )
  }

  const noun = target.kind === "server" ? "server" : "skill"

  return {
    target: target.kind,
    id: target.row.id,
    name: target.name,
    via,
    note,
    basis: noteBasis(current),
    shown: {
      title:
        note === null
          ? `Take away your note on ${target.name}?`
          : `Save this as your note on ${target.name}?`,
      lines: [
        `${noun === "server" ? "Server" : "Skill"}: ${target.label}`,
        `Your note now: ${current ?? "none"}`,
        note === null
          ? "It is taken away: assistants read no note of yours on it"
          : `Your note after, which every assistant that sees this ${noun} reads as yours:\n${note}`,
      ],
      warning:
        note === null
          ? null
          : "Assistants read your note as your own words, beside the description, in their instructions and in search. Agree only to what you would write yourself.",
    },
  }
}

/**
 * The owner agreed to a note: written as they read it, unless their note
 * changed since they were asked.
 */
export async function applyNoteChange(
  ctx: VaultContext,
  ask: NoteChangeAsk,
): Promise<string> {
  const row =
    ask.target === "server"
      ? await db().mcpServer.findFirst({
          where: { id: ask.id, vaultId: ctx.vaultId },
          select: { id: true, personalNote: true },
        })
      : await db().skill.findFirst({
          where: { id: ask.id, vaultId: ctx.vaultId },
          select: { id: true, personalNote: true },
        })

  if (!row) {
    throw notFound(ask.target === "server" ? "That server" : "That skill")
  }

  if (noteBasis(readNote(ctx, ask.target, row)) !== ask.basis) {
    throw new PcpError(
      "state",
      `The note on ${ask.name} changed since this was asked, so nothing was written. The assistant can ask again.`,
    )
  }

  await setPersonalNote(ctx, ask.target, ask.id, ask.note)

  return ask.note === null
    ? `The owner took away their note on ${ask.name}.`
    : `The owner saved the note on ${ask.name}; assistants read it as theirs.`
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
