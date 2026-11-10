import { AsyncLocalStorage } from "node:async_hooks"

import type { CallToolResult } from "@modelcontextprotocol/server"

import { MAY_HAVE_GONE_THROUGH } from "../code/runs"
import type { VaultContext } from "../context"
import { keyedHash } from "../crypto"
import { db } from "../db"
import { isPcpError } from "../errors"
import { newId } from "../ids"
import { pacedRetryAfter } from "../pacing/pace"
import { canonicalJson } from "../permission-rules"
import type { CodeCallOutcome } from "../permissions"
import { currentLogNote, type LogNote } from "../request-log"
import { keepResult } from "../tool-results"
import type { ToolTier } from "../tool-tiers"
import { errorCodeOf } from "../tools/outcome"
import { guardWindowMs, readDuplicateCalls } from "./config"
import {
  CALL_RECORD_KEEP_MS,
  STALE_RUNNING_MS,
  UNGUARDED_KINDS,
} from "./limits"

/**
 * The duplicate guard: a Write or Destructive call a token makes is
 * remembered for a while (`call_record`), and the same call made again
 * within that window (the same server, tool and arguments, as checked and
 * renamed) is not run: it is answered with how the first one went,
 * running, succeeded (with its answer kept as a result), failed, or asking
 * the owner. An assistant that means to do it twice says so (`rerun` with a
 * reason). The same tool with other arguments is only noted.
 *
 * It sits where a call is resolved, its arguments checked and before it
 * asks or runs: call_tool_write and call_tool_destructive (gateway.ts
 * callResolved), run_code's pcp.call and the capability tools (forwardCall)
 * and a wrapper's calls (wrappers/run.ts innerCall); never in upstream.ts,
 * so a call the owner allowed on PCP's page is not guarded. Read tools,
 * the kinds in UNGUARDED_KINDS and tools the owner exempted are not
 * either.
 *
 * Nothing of the arguments is stored but an HMAC under a key derived from
 * the vault key (callHash), so the table confirms no guess without it.
 */

const CALL_HASH_LABEL = "pcp call record v1"

export type GuardScope = { ctx: VaultContext; tokenId: string }

export type GuardTarget = {
  server: { id: string; slug: string; kind: string }
  tool: string
  tier: ToolTier
}

/** What makes two calls the same one: server, tool and arguments. */
export function callHash(
  dek: Buffer,
  serverId: string,
  tool: string,
  args: unknown,
): string {
  return keyedHash(
    dek,
    CALL_HASH_LABEL,
    `${serverId}\n${tool}\n${canonicalJson(args)}`,
  )
}

/** The record of a call under way, to end once it has its answer. */
export type CallTicket = {
  id: string
  scope: GuardScope
  serverId: string
  tool: string
}

export type GuardResult =
  /** The same call was made within the window: the answer that says how. */
  | { duplicate: string }
  /**
   * Go ahead. `ticket` is null when the call is not guarded; `warning`
   * names a call of the same tool with other arguments within the window.
   */
  | { ticket: CallTicket | null; warning: string | null }

type CallRow = {
  id: string
  status: string
  startedAt: Date
  finishedAt: Date | null
  resultId: string | null
  requestId: string | null
}

/**
 * A call the assistant repeats on purpose carries that to the calls made
 * under it: a wrapper's tool called again with rerun runs its program's
 * calls again too.
 */
const confirmedRerun = new AsyncLocalStorage<true>()

/** Runs `run` as part of a repeat the assistant confirmed, when `rerun`. */
export function asRerun<T>(rerun: boolean, run: () => Promise<T>): Promise<T> {
  return rerun ? confirmedRerun.run(true, run) : run()
}

/** How long ago, in words. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))

  if (s < 90) {
    return `${s} ${s === 1 ? "second" : "seconds"}`
  }

  const m = Math.round(s / 60)

  return m < 90
    ? `${m} ${m === 1 ? "minute" : "minutes"}`
    : `${Math.round(m / 60)} hours`
}

/**
 * How an earlier identical call went, as the lines of the answer; null
 * when it came to nothing (an ask the owner declined, withdrawn, closed or
 * expired), so it does not stand in the way.
 */
async function earlierLines(
  scope: GuardScope,
  row: CallRow,
  { asking, now }: { asking: boolean; now: Date },
): Promise<string[] | null> {
  const when = `${ago(now.getTime() - row.startedAt.getTime())} ago`

  switch (row.status) {
    case "running":
      return now.getTime() - row.startedAt.getTime() > STALE_RUNNING_MS
        ? [
            `It started ${when} and never reported back (PCP may have stopped under it), so it may have happened: check what it acts on first.`,
          ]
        : [
            `It started ${when} and is still running: its answer goes to the call that made it.`,
          ]
    case "succeeded":
      return [
        `It succeeded ${when}.`,
        ...(row.resultId
          ? [
              `Its answer is kept as {"$result": "${row.resultId}"}: read_result reads it.`,
            ]
          : []),
      ]
    case "failed":
      return [
        `It failed ${when}: the tool answered with an error, so most likely nothing happened; read that error before trying again.`,
      ]
    case "may_have_happened":
      return [`It failed on its way ${when}. ${MAY_HAVE_GONE_THROUGH}`]
    case "asked": {
      // The permission flow answers its own repeats (the same request, or
      // the answer of the run the owner allowed once).
      if (asking || !row.requestId) {
        return null
      }

      const request = await db().permissionRequest.findFirst({
        where: {
          id: row.requestId,
          vaultId: scope.ctx.vaultId,
          tokenId: scope.tokenId,
        },
        select: { status: true, expiresAt: true, decidedAt: true },
      })
      const check = `check_permission with id "${row.requestId}"`

      if (!request) {
        return null
      }

      if (request.status === "pending" && request.expiresAt > now) {
        return [
          `It asked the owner ${when} and is waiting for their answer: call ${check} for it.`,
        ]
      }

      if (request.status === "running") {
        return [
          `The owner allowed it and it is running now: call ${check} for its answer.`,
        ]
      }

      if (request.status === "executed" || request.status === "failed") {
        const ran = request.decidedAt
          ? ` ${ago(now.getTime() - request.decidedAt.getTime())} ago`
          : ""

        return [
          request.status === "executed"
            ? `The owner allowed it and it ran${ran}: call ${check} for its answer.`
            : `The owner allowed it and it failed${ran}: call ${check} for what happened.`,
        ]
      }

      return null
    }
    default:
      return null
  }
}

/**
 * Checks a call against the token's recent ones and, when it is guarded
 * and not a repeat, records it as running. `asking` is a call that will ask
 * the owner (the permission flow then finds its own earlier request).
 * `again` says how to make the call again on purpose, in the caller's
 * words (rerun on call_tool_*, options on pcp.call).
 */
export async function guardCall(
  scope: GuardScope,
  target: GuardTarget,
  args: unknown,
  {
    rerun = false,
    asking = false,
    again,
    now = new Date(),
  }: {
    rerun?: boolean
    asking?: boolean
    again: string
    now?: Date
  },
): Promise<GuardResult> {
  if (target.tier === "read" || UNGUARDED_KINDS.has(target.server.kind)) {
    return { ticket: null, warning: null }
  }

  const config = await readDuplicateCalls(scope.ctx.vaultId)
  const windowMs = guardWindowMs(config, target.server.id, target.tool)

  if (windowMs === null) {
    return { ticket: null, warning: null }
  }

  const argsHash = callHash(scope.ctx.dek, target.server.id, target.tool, args)
  // Under a call repeated on purpose (a wrapper's tool), its calls are too.
  rerun ||= confirmedRerun.getStore() === true
  const since = new Date(now.getTime() - windowMs)
  const id = newId()

  // Recorded first, then compared with what came before it: of two
  // identical calls at once, the later one is the repeat.
  await db().callRecord.create({
    data: {
      id,
      vaultId: scope.ctx.vaultId,
      tokenId: scope.tokenId,
      serverId: target.server.id,
      toolName: target.tool,
      argsHash,
      tier: target.tier,
      status: "running",
      startedAt: now,
    },
  })

  const before = {
    OR: [{ startedAt: { lt: now } }, { startedAt: now, id: { lt: id } }],
  }
  const name = `${target.server.slug}/${target.tool}`

  if (!rerun) {
    const earlier = await db().callRecord.findMany({
      where: {
        tokenId: scope.tokenId,
        argsHash,
        startedAt: { gte: since },
        ...before,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 5,
    })

    for (const row of earlier) {
      const lines = await earlierLines(scope, row, { asking, now })

      if (lines) {
        await db().callRecord.deleteMany({ where: { id } })

        return {
          duplicate: [
            `Not run again: ${name} was called with these same arguments ${ago(now.getTime() - row.startedAt.getTime())} ago (within the ${ago(windowMs)} PCP watches for repeats), so PCP did not run it a second time.`,
            ...lines,
            again,
          ].join("\n\n"),
        }
      }
    }
  }

  const near = await db().callRecord.findFirst({
    where: {
      tokenId: scope.tokenId,
      serverId: target.server.id,
      toolName: target.tool,
      startedAt: { gte: since },
      argsHash: { not: argsHash },
      status: { not: "asked" },
      ...before,
    },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  })

  return {
    ticket: {
      id,
      scope,
      serverId: target.server.id,
      tool: target.tool,
    },
    warning: near
      ? `Note: you called ${name} ${ago(now.getTime() - near.startedAt.getTime())} ago with other arguments; if this is the same action, check that one did not already do it.`
      : null,
  }
}

/** How a guarded call ended. */
export type CallEnd =
  | {
      status: "succeeded"
      /** What the assistant was answered, kept for a repeat to read. */
      answer?: { text: string; mediaType: string }
    }
  | { status: "failed" | "may_have_happened" }
  /** It asked the owner instead of running. */
  | { status: "asked"; requestId: string | null }
  /** Refused before anything was sent (pacing, a server to connect). */
  | { status: "nothing" }

/** How to make a call again on purpose, on call_tool_write/destructive. */
export const RERUN_ON_CALL =
  "If it really must happen again (a new message that only reads the same, a second payment you mean to make), call again with rerun: true and a reason saying why; otherwise use what the first call did."

/** The same, for run_code's pcp.call (and a wrapper's program). */
export const RERUN_IN_CODE =
  'If it really must happen again, pass { rerun: true, reason: "why" } in pcp.call\'s options; otherwise use what the first call did. The program sees this as an Error with code "duplicate_call".'

/** The codes of tool errors where nothing was done: forgotten. */
const NOTHING_DONE = new Set([
  "browser_busy",
  "rate_limited",
  "invalid_arguments",
  "validation",
  "forbidden",
  "duplicate_call",
])

/**
 * What the logged call's note says before it runs, to tell afterwards
 * whether the call asked the owner (a permission request, a server to
 * connect) instead of running.
 */
export function noteBefore(): {
  note: LogNote | undefined
  asked: boolean
  request: string | undefined
} {
  const note = currentLogNote()
  return { note, asked: note?.asked === true, request: note?.request }
}

function ownerEnd(before: ReturnType<typeof noteBefore>): CallEnd | null {
  const { note } = before

  if (!note?.asked || before.asked) {
    return null
  }

  return note.request && note.request !== before.request
    ? { status: "asked", requestId: note.request }
    : { status: "nothing" }
}

/** How a call that answered an MCP result ended (call_tool_*). */
export function endOfAnswer(
  result: CallToolResult,
  before: ReturnType<typeof noteBefore>,
): CallEnd {
  const owner = ownerEnd(before)

  if (owner) {
    return owner
  }

  if (result.isError) {
    if (pacedRetryAfter(result) !== null) {
      return { status: "nothing" }
    }

    const code = errorCodeOf(result)

    return code && NOTHING_DONE.has(code)
      ? { status: "nothing" }
      : code === "timeout" || code === "upstream"
        ? { status: "may_have_happened" }
        : { status: "failed" }
  }

  const text = (result.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")

  return {
    status: "succeeded",
    answer:
      text !== ""
        ? { text, mediaType: "text/plain" }
        : result.structuredContent
          ? {
              text: JSON.stringify(result.structuredContent),
              mediaType: "application/json",
            }
          : { text: "", mediaType: "text/plain" },
  }
}

/** How a call that answered a program's value ended (pcp.call). */
export function endOfOutcome(
  outcome: CodeCallOutcome,
  before: ReturnType<typeof noteBefore>,
): CallEnd {
  if ("owner" in outcome) {
    return ownerEnd(before) ?? { status: "nothing" }
  }

  if (outcome.ok) {
    return {
      status: "succeeded",
      answer:
        typeof outcome.value === "string"
          ? { text: outcome.value, mediaType: "text/plain" }
          : {
              text: JSON.stringify(outcome.value) ?? "",
              mediaType: "application/json",
            },
    }
  }

  if (
    outcome.refused ||
    outcome.code === "paced" ||
    (outcome.code && NOTHING_DONE.has(outcome.code))
  ) {
    return { status: "nothing" }
  }

  return outcome.transit || outcome.code === "timeout"
    ? { status: "may_have_happened" }
    : { status: "failed" }
}

/** How a call that threw ended. */
export function endOfThrow(error: unknown): CallEnd {
  if (isPcpError(error)) {
    return error.code === "unauthorized"
      ? { status: "nothing" }
      : error.code === "upstream"
        ? { status: "may_have_happened" }
        : { status: "failed" }
  }

  return { status: "may_have_happened" }
}

/** Ends a guarded call's record. A failure here never fails the call. */
export async function endCall(
  ticket: CallTicket | null,
  end: CallEnd,
  now = new Date(),
): Promise<void> {
  if (!ticket) {
    return
  }

  try {
    if (end.status === "nothing") {
      await db().callRecord.deleteMany({ where: { id: ticket.id } })
      return
    }

    let resultId: string | null = null

    if (end.status === "succeeded" && end.answer && end.answer.text !== "") {
      resultId = (
        await keepResult(ticket.scope.ctx, {
          tokenId: ticket.scope.tokenId,
          serverId: ticket.serverId,
          toolName: ticket.tool,
          text: end.answer.text,
          mediaType: end.answer.mediaType,
        })
      ).id
    }

    await db().callRecord.updateMany({
      where: { id: ticket.id },
      data: {
        status: end.status,
        finishedAt: now,
        resultId,
        requestId: end.status === "asked" ? end.requestId : null,
      },
    })
  } catch (error) {
    console.error("[calls] could not record how a call ended", error)
  }
}

/** The cleanup's part: records past the longest window. */
export async function pruneCallRecords(now = new Date()): Promise<number> {
  const { count } = await db().callRecord.deleteMany({
    where: {
      startedAt: { lte: new Date(now.getTime() - CALL_RECORD_KEEP_MS) },
    },
  })

  return count
}
