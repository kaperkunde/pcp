import type { Exit } from "@/lib/generated/prisma/client"

import { requireLiveToken } from "../api-tokens"
import { TOOL_ACCESS_LEVELS, type ToolAccess } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, notFound, PcpError } from "../errors"
import { newId } from "../ids"
import { closeSshConnections } from "../ssh/client"
import { forgetExitAnswers } from "./dial"
import { MAX_EXITS } from "./limits"
import { parseExitLabel, parseExitName } from "./names"

export { parseExitLabel, parseExitName }

/**
 * Exits as the vault keeps them (the `exit` table), and their levels.
 *
 * Only the owner adds, renames or removes an exit, on its SSH server's page.
 * An assistant names one in web_fetch's or the browser's `exit` argument;
 * whether it may use it is a level per token, kept as a web_fetch_rule of
 * kind "exit" keyed by the exit's id, the token's own or for all tokens,
 * the token's own winning: the same lines that decide which sites web fetch
 * and the browser reach, since an exit is only ever a way for those two to
 * go. Without a line an exit is blocked: an assistant cannot ask for one it
 * was never given, only for one the owner set to Ask you first.
 */

/** The scope of a line for all tokens (web-fetch.ts ALL_TOKENS). */
const ALL = "all"
const KIND = "exit"

export type ExitKind = "ssh" | "service"

export type ExitView = {
  id: string
  name: string
  label: string
  kind: ExitKind
  serverId: string
  serverName: string
  serviceId: string | null
}

function view(row: Exit & { server: { name: string } }): ExitView {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    kind: row.kind === "service" ? "service" : "ssh",
    serverId: row.serverId,
    serverName: row.server.name,
    serviceId: row.serviceId,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  )
}

export async function listExits(
  ctx: VaultContext,
  { serverId }: { serverId?: string } = {},
): Promise<ExitView[]> {
  const rows = await db().exit.findMany({
    where: { vaultId: ctx.vaultId, ...(serverId ? { serverId } : {}) },
    include: { server: { select: { name: true } } },
    orderBy: { name: "asc" },
  })

  return rows.map(view)
}

/** The exit an assistant named, or null. */
export async function findExitByName(
  ctx: VaultContext,
  name: string,
): Promise<ExitView | null> {
  const row = await db().exit.findUnique({
    where: {
      vaultId_name: { vaultId: ctx.vaultId, name: name.trim().toLowerCase() },
    },
    include: { server: { select: { name: true } } },
  })

  return row ? view(row) : null
}

export async function getExit(
  ctx: VaultContext,
  id: string,
): Promise<ExitView> {
  const row = await db().exit.findFirst({
    where: { id, vaultId: ctx.vaultId },
    include: { server: { select: { name: true } } },
  })

  if (!row) {
    throw notFound("That exit")
  }

  return view(row)
}

/** The owner adds an exit that leaves from one of their SSH servers. */
export async function createSshExit(
  ctx: VaultContext,
  input: { serverId: string; name: string; label?: string },
): Promise<{ id: string }> {
  const name = parseExitName(input.name)
  const label = parseExitLabel(input.label)
  const server = await db().mcpServer.findFirst({
    where: { id: input.serverId, vaultId: ctx.vaultId },
    select: { kind: true },
  })

  if (!server) {
    throw notFound("That SSH server")
  }

  if (server.kind !== "ssh") {
    throw invalid("An exit leaves from one of your SSH servers.")
  }

  if (
    (await db().exit.count({ where: { vaultId: ctx.vaultId } })) >= MAX_EXITS
  ) {
    throw invalid(`PCP keeps at most ${MAX_EXITS} exits.`)
  }

  const id = newId()

  try {
    await db().exit.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        name,
        label,
        kind: "ssh",
        serverId: input.serverId,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PcpError("conflict", `There is an exit called ${name} already.`)
    }

    throw error
  }

  return { id }
}

export async function updateExit(
  ctx: VaultContext,
  id: string,
  input: { name: string; label?: string },
): Promise<void> {
  await getExit(ctx, id)
  const name = parseExitName(input.name)
  const label = parseExitLabel(input.label)

  try {
    await db().exit.update({ where: { id }, data: { name, label } })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PcpError("conflict", `There is an exit called ${name} already.`)
    }

    throw error
  }
}

/** Removes an exit and every level set for it. */
export async function deleteExit(ctx: VaultContext, id: string): Promise<void> {
  const exit = await getExit(ctx, id)

  await db().$transaction([
    db().webFetchRule.deleteMany({
      where: { vaultId: ctx.vaultId, kind: KIND, key: id },
    }),
    db().exit.delete({ where: { id } }),
  ])
  forgetExitAnswers(id)

  // The connection closes once no other exit of the server is in use: the
  // next call that needs one opens it again.
  if ((await db().exit.count({ where: { serverId: exit.serverId } })) === 0) {
    closeSshConnections(exit.serverId)
  }
}

// ---- Levels -------------------------------------------------------------------

function asAccess(value: string | null | undefined): ToolAccess | null {
  return value && (TOOL_ACCESS_LEVELS as readonly string[]).includes(value)
    ? (value as ToolAccess)
    : null
}

export type ExitDecision = {
  access: ToolAccess
  /** Which line decided: the token's own, the one for all tokens, or none. */
  by: "own" | "all" | "none"
}

/** Whether a token may use an exit: its own line, else all tokens', else blocked. */
export async function decideExit(
  vaultId: string,
  tokenId: string,
  exitId: string,
): Promise<ExitDecision> {
  const rows = await db().webFetchRule.findMany({
    where: { vaultId, kind: KIND, key: exitId, scope: { in: [tokenId, ALL] } },
  })
  const own = asAccess(rows.find((row) => row.scope === tokenId)?.access)
  const all = asAccess(rows.find((row) => row.scope === ALL)?.access)

  if (own) return { access: own, by: "own" }
  if (all) return { access: all, by: "all" }
  return { access: "blocked", by: "none" }
}

export type ExitLevelView = ExitView & {
  /** What applies to the token: its own line, else all tokens', else blocked. */
  access: ToolAccess
  own: ToolAccess | null
  shared: ToolAccess | null
}

/** Every exit, with the token's level for it, for the token's page. */
export async function listExitLevels(
  ctx: VaultContext,
  tokenId: string,
): Promise<ExitLevelView[]> {
  const [exits, rows] = await Promise.all([
    listExits(ctx),
    db().webFetchRule.findMany({
      where: {
        vaultId: ctx.vaultId,
        kind: KIND,
        scope: { in: [tokenId, ALL] },
      },
    }),
  ])

  return exits.map((exit) => {
    const own = asAccess(
      rows.find((row) => row.key === exit.id && row.scope === tokenId)?.access,
    )
    const shared = asAccess(
      rows.find((row) => row.key === exit.id && row.scope === ALL)?.access,
    )

    return { ...exit, access: own ?? shared ?? "blocked", own, shared }
  })
}

function where(vaultId: string, scope: string, key: string) {
  return { vaultId_scope_kind_key: { vaultId, scope, kind: KIND, key } }
}

/**
 * Writes a line for an exit: the token's own (`tokenId`) or for all tokens
 * (null). The owner's alone, from the token's page or their answer to a
 * request; nothing an assistant sends calls it.
 */
export async function writeExitAccess(
  vaultId: string,
  tokenId: string | null,
  exitId: string,
  access: ToolAccess,
): Promise<void> {
  const scope = tokenId ?? ALL

  await db().webFetchRule.upsert({
    where: where(vaultId, scope, exitId),
    create: {
      id: newId(),
      vaultId,
      tokenId,
      scope,
      kind: KIND,
      key: exitId,
      access,
      addedBy: "owner",
    },
    update: { access },
  })
}

/** The token's own level for an exit, set on its page. */
export async function setExitLevel(
  ctx: VaultContext,
  tokenId: string,
  exitId: string,
  rawAccess: string,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  await getExit(ctx, exitId)
  const access = asAccess(rawAccess)

  if (!access) {
    throw invalid("Choose Allowed, Ask you first or Blocked.")
  }

  const shared = await db().webFetchRule.findUnique({
    where: where(ctx.vaultId, ALL, exitId),
  })

  // Blocked needs a line only to override one for all tokens.
  if (access === "blocked" && !asAccess(shared?.access)) {
    await db().webFetchRule.deleteMany({
      where: { vaultId: ctx.vaultId, scope: tokenId, kind: KIND, key: exitId },
    })
    return
  }

  await writeExitAccess(ctx.vaultId, tokenId, exitId, access)
}

/**
 * The "All tokens" box on an exit's line: ticked, the level that applies
 * to this token becomes the one for every token and its own line goes;
 * unticked, the line for all tokens goes and this token keeps the level as
 * its own.
 */
export async function setExitLevelShared(
  ctx: VaultContext,
  tokenId: string,
  exitId: string,
  shared: boolean,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  await getExit(ctx, exitId)
  const { access } = await decideExit(ctx.vaultId, tokenId, exitId)
  const own = { vaultId: ctx.vaultId, scope: tokenId, kind: KIND, key: exitId }
  const all = { vaultId: ctx.vaultId, scope: ALL, kind: KIND, key: exitId }

  if (shared) {
    await db().$transaction([
      db().webFetchRule.upsert({
        where: where(ctx.vaultId, ALL, exitId),
        create: {
          id: newId(),
          ...all,
          tokenId: null,
          access,
          addedBy: "owner",
        },
        update: { access },
      }),
      db().webFetchRule.deleteMany({ where: own }),
    ])
    return
  }

  if (access === "blocked") {
    await db().$transaction([
      db().webFetchRule.deleteMany({ where: all }),
      db().webFetchRule.deleteMany({ where: own }),
    ])
    return
  }

  await db().$transaction([
    db().webFetchRule.deleteMany({ where: all }),
    db().webFetchRule.upsert({
      where: where(ctx.vaultId, tokenId, exitId),
      create: { id: newId(), ...own, tokenId, access, addedBy: "owner" },
      update: { access },
    }),
  ])
}
