import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, PcpError } from "../errors"
import { hiddenCharacter } from "../memories"
import { openServer } from "../server-meta"
import {
  applyLimitsChange,
  checkLimits,
  effectiveLimits,
  LIMIT_FIELDS,
  LIMIT_WORDS,
  limitsChangeLines,
  sameLimits,
  showValue,
  type LimitField,
  type LimitsChange,
  type ServerLimits,
} from "./config"
import { mailDiagnostics, type MailDiagnostic } from "../mail/diagnostics"
import { gateClassOf, GATE_DEFAULTS, type GateClass } from "./limits"
import { endCooling, placeView, serverPlace } from "./state"
import { limitsBasis, readServerLimits, writeServerLimits } from "./store"

/**
 * An assistant's proposal of a server's limits (lib/core/gate/): a
 * `limits_change` request (propose_server_limits) that shows the owner the
 * limits now, the ones proposed and the assistant's note on why, editable
 * beside the approval, and writes only what they saved, over the limits as
 * they were when asked (`basis`). register_server's `limits` is the same
 * shown on a new server's request (RegisterArgs `proposedLimits`) and
 * written with the owner's yes. Nothing an assistant sends writes them.
 */

export const MAX_LIMITS_NOTE = 300

export type LimitsChangeAsk = {
  serverId: string
  serverName: string
  serverSlug: string
  gateClass: GateClass
  /** The server's own limits as the owner is shown them. */
  before: ServerLimits
  /** What they would be. */
  proposed: ServerLimits
  /** Why, in the assistant's words. */
  note: string
  basis: string
}

/** One limit as the page shows it, editable: no PCP code in the browser. */
export type LimitFieldShown = {
  field: LimitField
  label: string
  unit: "calls" | "ms" | "bytes"
  /** May be "none" (no cap of its own). */
  nullable: boolean
  /** What the kind follows without one of its own, in words. */
  defaultShown: string
  defaultValue: number | null
  /** The value filled in: a number, null for none, undefined for default. */
  value?: number | null
}

export type LimitsShown = { fields: LimitFieldShown[] }

const NULLABLE = new Set<LimitField>(["callsPerMinute", "bytesPerDay"])

/** The limits filled in for the page, over the class's defaults. */
export function limitsShown(
  gateClass: GateClass,
  values: ServerLimits,
): LimitsShown {
  const defaults = GATE_DEFAULTS[gateClass]

  return {
    fields: LIMIT_FIELDS.map((field) => ({
      field,
      label: LIMIT_WORDS[field].label,
      unit: LIMIT_WORDS[field].unit,
      nullable: NULLABLE.has(field),
      defaultShown: showValue(field, defaults[field]),
      defaultValue: defaults[field],
      ...(field in values ? { value: values[field] ?? null } : {}),
    })),
  }
}

/** The note on a proposal: why, on one line, short enough to read whole. */
export function checkLimitsNote(input: string): string {
  const note = input.trim()

  if (!note) {
    throw invalid("Say in note why these limits, in a line.")
  }

  if (/[\r\n\u2028\u2029]/u.test(note)) {
    throw invalid("Keep the note on one line.")
  }

  const hidden = hiddenCharacter(note)

  if (hidden) {
    throw invalid(
      `The note holds a character that does not show on screen (${hidden}). Take it out.`,
    )
  }

  if ([...note].length > MAX_LIMITS_NOTE) {
    throw invalid(`Keep the note to ${MAX_LIMITS_NOTE} characters.`)
  }

  return note
}

/**
 * A proposal for a server's limits, read against its limits now; null
 * when it changes nothing.
 */
export async function proposeLimits(
  ctx: VaultContext,
  server: { id: string; name: string; slug: string; kind: string },
  change: LimitsChange,
  note: string,
): Promise<LimitsChangeAsk | null> {
  const gateClass = gateClassOf(server.kind)

  if (!gateClass) {
    throw invalid(
      `${server.name} has no limits of its own: ${server.kind === "browser" ? "the browser is paced per site" : "a wrapper's calls go by the limits of the servers it calls"}.`,
    )
  }

  const said = checkLimitsNote(note)
  const before = await readServerLimits(ctx, server.id)
  const proposed = applyLimitsChange(before, change)

  if (sameLimits(before, proposed)) {
    return null
  }

  return {
    serverId: server.id,
    serverName: server.name,
    serverSlug: server.slug,
    gateClass,
    before,
    proposed,
    note: said,
    basis: limitsBasis(before),
  }
}

/** What the owner is shown of a proposal. */
export function describeLimitsAsk(ask: LimitsChangeAsk): {
  title: string
  lines: string[]
  warning: string | null
} {
  const changes = limitsChangeLines(ask.gateClass, ask.before, ask.proposed)

  return {
    title: `Change the limits of ${ask.serverName}?`,
    lines: [
      ...changes,
      `Why, in the assistant's words: ${ask.note}`,
      "PCP holds every call to it to these, whatever way it comes. You can change any of them below before you save.",
    ],
    warning: null,
  }
}

/**
 * Limits as the owner left them on the page: each field a number, null
 * for none, left out for PCP's default. Checked before anything is
 * written, so a mistake can be fixed and answered again.
 */
export function checkChosenLimits(chosen: unknown): ServerLimits {
  return checkLimits(chosen ?? {})
}

/**
 * The owner's yes: their limits, written over the server's limits as they
 * were shown, or nothing.
 */
export async function saveProposedLimits(
  ctx: VaultContext,
  ask: LimitsChangeAsk,
  chosen: ServerLimits | null,
): Promise<string> {
  const row = await db().mcpServer.findFirst({
    where: { id: ask.serverId, vaultId: ctx.vaultId },
  })

  if (!row) {
    throw new PcpError("state", `${ask.serverName} is no longer in PCP.`)
  }

  const now = await readServerLimits(ctx, ask.serverId)

  if (limitsBasis(now) !== ask.basis) {
    throw new PcpError(
      "state",
      `The limits of ${ask.serverName} have changed since this was asked, so nothing was saved. The assistant can ask again.`,
    )
  }

  const saved = await writeServerLimits(
    ctx,
    ask.serverId,
    chosen ?? ask.proposed,
  )
  const server = openServer(ctx, row)
  const changed = limitsChangeLines(ask.gateClass, now, saved)

  return changed.length === 0
    ? `The owner kept the limits of ${server.name} as they were.`
    : `The owner saved the limits of ${server.name}: ${changed.join("; ")}.`
}

/** A server's limits in a line, for an answer: its own and the defaults. */
export function limitsLine(gateClass: GateClass, own: ServerLimits): string {
  const limits = effectiveLimits(gateClass, own)

  return LIMIT_FIELDS.map(
    (field) =>
      `${LIMIT_WORDS[field].label.toLowerCase()} ${showValue(field, limits[field])}${field in own ? "" : " (default)"}`,
  ).join(", ")
}

/** A server's Limits section, as its page shows it. */
export type ServerLimitsView = {
  limits: LimitsShown
  /**
   * A mail account's last calls (mail/diagnostics.ts), newest first: each
   * phase's time, whether it reused a connection, how it went and what the
   * server said on its own. Empty for any other kind.
   */
  mailCalls: MailDiagnostic[]
  cooling: { reason: string; since: Date; until: Date } | null
  running: number
  waiting: number
  since: Date
  windows: Array<{
    label: string
    calls: number
    errors: number
    throttles: number
    bytes: number
    p50Ms: number | null
    p95Ms: number | null
  }>
}

/** The Limits section of a server's page; null for one without limits. */
export async function serverLimitsView(
  ctx: VaultContext,
  server: { id: string; kind: string },
): Promise<ServerLimitsView | null> {
  const gateClass = gateClassOf(server.kind)

  if (!gateClass) {
    return null
  }

  const own = await readServerLimits(ctx, server.id)
  const view = placeView(serverPlace(ctx.vaultId, server.id))

  return {
    limits: limitsShown(gateClass, own),
    mailCalls: gateClass === "mail" ? mailDiagnostics(server.id) : [],
    cooling: view.cooling
      ? {
          reason: view.cooling.reason,
          since: new Date(view.cooling.since),
          until: new Date(view.cooling.until),
        }
      : null,
    running: view.running,
    waiting: view.waiting,
    since: new Date(view.since),
    windows: [
      { label: "Last minute", ...view.minute },
      { label: "Last hour", ...view.hour },
      { label: "Last day", ...view.day },
    ],
  }
}

/** The owner's own save of a server's limits, on its page. */
export async function saveOwnerLimits(
  ctx: VaultContext,
  serverId: string,
  input: unknown,
): Promise<ServerLimits> {
  const row = await db().mcpServer.findFirst({
    where: { id: serverId, vaultId: ctx.vaultId },
    select: { kind: true },
  })

  if (!row || !gateClassOf(row.kind)) {
    throw invalid("That server has no limits of its own.")
  }

  return writeServerLimits(ctx, serverId, checkLimits(input))
}

/** The owner ends a server's cool-down now, on its page. */
export async function endServerCooling(
  ctx: VaultContext,
  serverId: string,
): Promise<void> {
  endCooling(serverPlace(ctx.vaultId, serverId))
}
