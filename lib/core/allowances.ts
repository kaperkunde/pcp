import { requireToken } from "./api-tokens"
import { endSecretAllowance, listSecretAllowances } from "./browser-secrets"
import { ALLOW_FOR_MINUTES, type AllowForMinutes } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid } from "./errors"
import { accessKey } from "./tool-access"

/**
 * "Allow for" on a permission request: a tool, or a site, that one token may
 * use without asking the owner until a time.
 *
 * An allowance is not a level. It is consulted only where the token's levels
 * come out at "ask" (the gateway's tools, web fetch's and the browser's
 * sites), lifts that to "allowed" until it runs out, and never lifts a block.
 * When it runs out the levels decide again, as they were, so a token's own
 * "ask" over an "allowed" for all tokens is still asked about afterwards.
 *
 * The gateway has no sessions (app/mcp/route.ts), and nothing an MCP client
 * sends names a conversation, so a time is what "for now" can mean.
 * Allowances are not exported: like kept results, they are short-lived and
 * bound to the tokens a restore replaces.
 *
 * A secret the browser types has allowances of its own, per secret and site
 * (lib/core/browser-secrets.ts): listed and ended here with the rest, on
 * the token's page, and pruned with them once they run out ("always" ones
 * do not run out).
 */

export type TokenAllowance =
  | {
      kind: "tool"
      serverId: string
      serverName: string
      toolName: string
      until: Date
    }
  | { kind: "site"; host: string; until: Date }
  | {
      kind: "secret"
      secretId: string
      secretName: string
      origin: string
      /** Null: always. */
      until: Date | null
      /** Its next use only. */
      once: boolean
    }

/** The owner's choice of how long, or why not. */
export function parseAllowForMinutes(value: unknown): AllowForMinutes {
  const minutes = typeof value === "string" ? Number(value) : value

  if (!(ALLOW_FOR_MINUTES as readonly unknown[]).includes(minutes)) {
    throw invalid(`Allow for one of: ${ALLOW_FOR_MINUTES.join(", ")} minutes.`)
  }

  return minutes as AllowForMinutes
}

function untilFrom(minutes: AllowForMinutes, now: Date): Date {
  return new Date(now.getTime() + minutes * 60_000)
}

/** Lets one token run one tool without asking, for `minutes` from `now`. */
export async function allowToolFor(
  tokenId: string,
  serverId: string,
  toolName: string,
  minutes: AllowForMinutes,
  now = new Date(),
): Promise<Date> {
  const until = untilFrom(minutes, now)

  await db().apiTokenToolAllowance.upsert({
    where: { tokenId_serverId_toolName: { tokenId, serverId, toolName } },
    create: { tokenId, serverId, toolName, until },
    update: { until },
  })

  return until
}

/** Lets one token reach one site without asking, for `minutes` from `now`. */
export async function allowSiteFor(
  tokenId: string,
  host: string,
  minutes: AllowForMinutes,
  now = new Date(),
): Promise<Date> {
  const until = untilFrom(minutes, now)

  await db().apiTokenSiteAllowance.upsert({
    where: { tokenId_host: { tokenId, host } },
    create: { tokenId, host, until },
    update: { until },
  })

  return until
}

/** The token's tools allowed for now, keyed by accessKey(), to when. */
export async function loadToolAllowances(
  tokenId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  const rows = await db().apiTokenToolAllowance.findMany({
    where: { tokenId, until: { gt: now } },
    select: { serverId: true, toolName: true, until: true },
  })

  return new Map(
    rows.map((row) => [
      accessKey(row.serverId, row.toolName),
      row.until.getTime(),
    ]),
  )
}

/** The token's sites allowed for now, by host, to when. */
export async function loadSiteAllowances(
  tokenId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  const rows = await db().apiTokenSiteAllowance.findMany({
    where: { tokenId, until: { gt: now } },
    select: { host: true, until: true },
  })

  return new Map(rows.map((row) => [row.host, row.until.getTime()]))
}

/** Whether an allowance that lasts to `until` (ms) still holds at `now`. */
export function allowanceHolds(
  until: number | undefined,
  now = Date.now(),
): boolean {
  return until !== undefined && until > now
}

/** What a token is allowed for now, soonest to run out first, for its page. */
export async function listTokenAllowances(
  ctx: VaultContext,
  tokenId: string,
  now = new Date(),
): Promise<TokenAllowance[]> {
  await requireToken(ctx, tokenId)

  const [tools, sites, secrets] = await Promise.all([
    db().apiTokenToolAllowance.findMany({
      where: { tokenId, until: { gt: now } },
      include: { server: { select: { name: true } } },
    }),
    db().apiTokenSiteAllowance.findMany({
      where: { tokenId, until: { gt: now } },
    }),
    listSecretAllowances(ctx, { tokenId }, now),
  ])

  return [
    ...tools.map((row): TokenAllowance => ({
      kind: "tool",
      serverId: row.serverId,
      serverName: row.server.name,
      toolName: row.toolName,
      until: row.until,
    })),
    ...sites.map((row): TokenAllowance => ({
      kind: "site",
      host: row.host,
      until: row.until,
    })),
    ...secrets.map((row): TokenAllowance => ({
      kind: "secret",
      secretId: row.secretId,
      secretName: row.secretName,
      origin: row.origin,
      until: row.until,
      once: row.once,
    })),
  ].sort(
    (a, b) =>
      (a.until?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (b.until?.getTime() ?? Number.MAX_SAFE_INTEGER),
  )
}

/** The owner ends an allowance before its time: that tool or site asks again. */
export async function endAllowance(
  ctx: VaultContext,
  tokenId: string,
  target:
    | { kind: "tool"; serverId: string; toolName: string }
    | { kind: "site"; host: string }
    | { kind: "secret"; secretId: string; origin: string },
): Promise<void> {
  await requireToken(ctx, tokenId)

  if (target.kind === "secret") {
    await endSecretAllowance(ctx, {
      tokenId,
      secretId: target.secretId,
      origin: target.origin,
    })
  } else if (target.kind === "tool") {
    await db().apiTokenToolAllowance.deleteMany({
      where: { tokenId, serverId: target.serverId, toolName: target.toolName },
    })
  } else {
    await db().apiTokenSiteAllowance.deleteMany({
      where: { tokenId, host: target.host },
    })
  }
}

/** Deletes allowances that have run out. */
export async function pruneAllowances(now = new Date()): Promise<number> {
  const where = { until: { lte: now } }
  const [tools, sites, secrets] = await Promise.all([
    db().apiTokenToolAllowance.deleteMany({ where }),
    db().apiTokenSiteAllowance.deleteMany({ where }),
    // "Always" ones have no end, and stay.
    db().apiTokenSecretAllowance.deleteMany({ where }),
  ])

  return tools.count + sites.count + secrets.count
}
