import type { CallToolResult } from "@modelcontextprotocol/server"

import type { WebFetchRule } from "@/lib/generated/prisma/client"

import { requireLiveToken, requireToken } from "./api-tokens"
import {
  FETCH_METHOD_GROUPS,
  TOOL_ACCESS_LEVELS,
  type FetchMethodGroup,
  type FetchSiteLevel,
  type ToolAccess,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound } from "./errors"
import { newId } from "./ids"
import { fetchWeb, type FetchOptions } from "./fetch/fetch"
import { MAX_FETCH_RULES } from "./fetch/limits"
import type { FetchArgs } from "./fetch/request"
import {
  emptyRules,
  fromSiteLevel,
  isMethodGroup,
  knowsSite,
  methodGroup,
  normalizeSite,
  resolveFetchAccess,
  siteKey,
  toSiteLevel,
  type FetchDecision,
  type FetchRuleSet,
} from "./fetch/rules"

/**
 * The levels web_fetch follows, as stored (web_fetch_rule), and what the
 * owner does with them on a token's page. The decision itself is in
 * fetch/rules.ts; the request and the page in fetch/request.ts and
 * fetch/fetch.ts.
 *
 * A site an assistant reaches for the first time gets a line of its own on
 * the token's page, following the method levels, so the owner sees every
 * site it tried and can decide each one. A line can be the token's own or
 * for all tokens; the token's own wins.
 */

/** The scope of a rule for all tokens; any other scope is a token's id. */
export const ALL_TOKENS = "all"

export type FetchRuleKind = "method" | "site"

export type FetchAddedBy = "assistant" | "owner"

export type FetchMethodView = {
  group: FetchMethodGroup
  /** What applies to the token: its own level, else all tokens', else ask. */
  access: ToolAccess
  own: ToolAccess | null
  shared: ToolAccess | null
}

export type FetchSiteView = {
  host: string
  /** The line that applies: the token's own, else the one for all tokens. */
  level: FetchSiteLevel
  own: FetchSiteLevel | null
  shared: FetchSiteLevel | null
  addedBy: FetchAddedBy
  createdAt: Date
  lastFetchedAt: Date | null
}

export type TokenFetchRules = {
  methods: FetchMethodView[]
  sites: FetchSiteView[]
}

function asAccess(value: string | null): ToolAccess | null {
  return value !== null &&
    (TOOL_ACCESS_LEVELS as readonly string[]).includes(value)
    ? (value as ToolAccess)
    : null
}

function asAddedBy(value: string): FetchAddedBy {
  return value === "owner" ? "owner" : "assistant"
}

function ruleRows(vaultId: string, tokenId: string): Promise<WebFetchRule[]> {
  return db().webFetchRule.findMany({
    where: { vaultId, scope: { in: [tokenId, ALL_TOKENS] } },
  })
}

function toRuleSet(rows: WebFetchRule[]): FetchRuleSet {
  const rules = emptyRules()

  for (const row of rows) {
    const shared = row.scope === ALL_TOKENS
    const access = asAccess(row.access)

    if (row.kind === "method") {
      if (access && isMethodGroup(row.key)) {
        ;(shared ? rules.sharedMethods : rules.ownMethods).set(row.key, access)
      }
    } else if (row.kind === "site") {
      ;(shared ? rules.sharedSites : rules.ownSites).set(row.key, access)
    }
  }

  return rules
}

export async function loadFetchRules(
  vaultId: string,
  tokenId: string,
): Promise<FetchRuleSet> {
  return toRuleSet(await ruleRows(vaultId, tokenId))
}

/** The site a request goes to. */
export function fetchHostOf(args: Pick<FetchArgs, "url">): string {
  return siteKey(new URL(args.url))
}

async function roomForOneMore(vaultId: string): Promise<void> {
  const count = await db().webFetchRule.count({ where: { vaultId } })

  if (count >= MAX_FETCH_RULES) {
    throw invalid(
      `PCP keeps at most ${MAX_FETCH_RULES.toLocaleString("en")} web fetch sites and method settings. Remove some on a token's page first.`,
    )
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  )
}

/**
 * Which level a request from this token gets. A site the token has no line
 * for yet, its own or all tokens', gets one of its own here, following the
 * methods: that is how every site an assistant tried shows on the page.
 */
export async function decideFetch(
  scope: { ctx: VaultContext; tokenId: string },
  args: FetchArgs,
): Promise<FetchDecision & { host: string; group: FetchMethodGroup }> {
  const host = fetchHostOf(args)
  const group = methodGroup(args.method)
  const rules = await loadFetchRules(scope.ctx.vaultId, scope.tokenId)

  if (!knowsSite(rules, host)) {
    await roomForOneMore(scope.ctx.vaultId)

    try {
      await db().webFetchRule.create({
        data: {
          id: newId(),
          vaultId: scope.ctx.vaultId,
          tokenId: scope.tokenId,
          scope: scope.tokenId,
          kind: "site",
          key: host,
          access: null,
          addedBy: "assistant",
        },
      })
    } catch (error) {
      // Two first fetches at once: the other one made the line.
      if (!isUniqueViolation(error)) {
        throw error
      }
    }

    rules.ownSites.set(host, null)
  }

  return { ...resolveFetchAccess(rules, host, group), host, group }
}

/** Notes when a site was last fetched, on the line that decided it. */
export async function recordFetch(
  vaultId: string,
  tokenId: string,
  host: string,
): Promise<void> {
  const now = new Date()
  const own = await db().webFetchRule.updateMany({
    where: { vaultId, scope: tokenId, kind: "site", key: host },
    data: { lastFetchedAt: now },
  })

  if (own.count === 0) {
    await db().webFetchRule.updateMany({
      where: { vaultId, scope: ALL_TOKENS, kind: "site", key: host },
      data: { lastFetchedAt: now },
    })
  }
}

/**
 * The owner's "Always allow this site" or "Block this site", answering an
 * assistant's request: the token's own line, as a tool's answer sets the
 * token's own level.
 */
export async function writeSiteAccess(
  vaultId: string,
  tokenId: string,
  host: string,
  access: ToolAccess,
): Promise<void> {
  await db().webFetchRule.upsert({
    where: {
      vaultId_scope_kind_key: {
        vaultId,
        scope: tokenId,
        kind: "site",
        key: host,
      },
    },
    create: {
      id: newId(),
      vaultId,
      tokenId,
      scope: tokenId,
      kind: "site",
      key: host,
      access,
      addedBy: "assistant",
    },
    update: { access },
  })
}

/** Runs an allowed request and notes that the site was fetched. */
export async function runFetch(
  ctx: VaultContext,
  tokenId: string,
  args: FetchArgs,
  fetcher: (
    args: FetchArgs,
    options?: FetchOptions,
  ) => Promise<CallToolResult> = fetchWeb,
): Promise<CallToolResult> {
  const result = await fetcher(args)
  await recordFetch(ctx.vaultId, tokenId, fetchHostOf(args))
  return result
}

const CHANGING_METHODS_WARNING =
  "can change or delete things at this address, and sends it the body shown. Only allow it if you expect the assistant to do that there."

/** What the owner is shown before a web request runs. */
export function describeFetchAsk(args: FetchArgs): {
  title: string
  lines: string[]
  warning: string | null
} {
  const host = fetchHostOf(args)
  const reading = args.method === "GET" || args.method === "HEAD"
  const headers = Object.entries(args.headers)
  const body = args.body ?? ""
  const clipped = body.length > 2000 ? `${body.slice(0, 1999)}…` : body

  return {
    title: reading
      ? `Fetch a page from ${host}?`
      : `Send a ${args.method} request to ${host}?`,
    lines: [
      `Address: ${args.url}`,
      `Method: ${args.method}`,
      ...(headers.length > 0
        ? [
            `Headers: ${headers.map(([name, value]) => `${name}: ${value.length > 200 ? `${value.slice(0, 199)}…` : value}`).join("; ")}`,
          ]
        : []),
      ...(body
        ? [`Body (${body.length.toLocaleString("en")} characters):\n${clipped}`]
        : []),
      "From PCP's own address, public addresses only, with none of your secrets",
    ],
    warning: reading
      ? null
      : `A ${args.method} request ${CHANGING_METHODS_WARNING}`,
  }
}

// What the owner does on a token's page.

function viewRules(rows: WebFetchRule[], tokenId: string): TokenFetchRules {
  const own = rows.filter((row) => row.scope === tokenId)
  const shared = rows.filter((row) => row.scope === ALL_TOKENS)
  const find = (list: WebFetchRule[], kind: FetchRuleKind, key: string) =>
    list.find((row) => row.kind === kind && row.key === key) ?? null

  const methods = FETCH_METHOD_GROUPS.map((group) => {
    const mine = asAccess(find(own, "method", group)?.access ?? null)
    const all = asAccess(find(shared, "method", group)?.access ?? null)

    return { group, access: mine ?? all ?? "ask", own: mine, shared: all }
  })

  const hosts = [
    ...new Set(rows.filter((row) => row.kind === "site").map((row) => row.key)),
  ]
  const sites = hosts.map((host) => {
    const mine = find(own, "site", host)
    const all = find(shared, "site", host)
    const governing = (mine ?? all)!

    return {
      host,
      level: toSiteLevel(asAccess(governing.access)),
      own: mine ? toSiteLevel(asAccess(mine.access)) : null,
      shared: all ? toSiteLevel(asAccess(all.access)) : null,
      addedBy: asAddedBy(governing.addedBy),
      createdAt: governing.createdAt,
      lastFetchedAt: governing.lastFetchedAt,
    }
  })

  // The sites in use first, then the newest.
  sites.sort(
    (a, b) =>
      (b.lastFetchedAt ?? b.createdAt).getTime() -
      (a.lastFetchedAt ?? a.createdAt).getTime(),
  )

  return { methods, sites }
}

/** A token's method levels and every site it has a line for. */
export async function listFetchRules(
  ctx: VaultContext,
  tokenId: string,
): Promise<TokenFetchRules> {
  await requireToken(ctx, tokenId)
  return viewRules(await ruleRows(ctx.vaultId, tokenId), tokenId)
}

function parseGroup(value: string): FetchMethodGroup {
  if (isMethodGroup(value)) {
    return value
  }

  throw invalid("Choose one of the methods shown.")
}

function parseLevel(value: string): ToolAccess {
  if ((TOOL_ACCESS_LEVELS as readonly string[]).includes(value)) {
    return value as ToolAccess
  }

  throw invalid("Choose Allowed, Ask you first or Blocked.")
}

export function parseSiteLevel(value: string): FetchSiteLevel {
  return value === "default" ? "default" : parseLevel(value)
}

function where(
  vaultId: string,
  scope: string,
  kind: FetchRuleKind,
  key: string,
) {
  return { vaultId_scope_kind_key: { vaultId, scope, kind, key } }
}

async function findRule(
  vaultId: string,
  scope: string,
  kind: FetchRuleKind,
  key: string,
): Promise<WebFetchRule | null> {
  return db().webFetchRule.findUnique({
    where: where(vaultId, scope, kind, key),
  })
}

/** The token's own level for a method. */
export async function setFetchMethod(
  ctx: VaultContext,
  tokenId: string,
  group: string,
  access: string,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const key = parseGroup(group)
  const level = parseLevel(access)
  const shared = await findRule(ctx.vaultId, ALL_TOKENS, "method", key)

  // Ask needs a line only to override one for all tokens.
  if (level === "ask" && !shared) {
    await db().webFetchRule.deleteMany({
      where: { vaultId: ctx.vaultId, scope: tokenId, kind: "method", key },
    })
    return
  }

  const existing = await findRule(ctx.vaultId, tokenId, "method", key)

  if (!existing) {
    await roomForOneMore(ctx.vaultId)
  }

  await db().webFetchRule.upsert({
    where: where(ctx.vaultId, tokenId, "method", key),
    create: {
      id: newId(),
      vaultId: ctx.vaultId,
      tokenId,
      scope: tokenId,
      kind: "method",
      key,
      access: level,
      addedBy: "owner",
    },
    update: { access: level },
  })
}

/** The token's own level for a site; it gets a line of its own if it had none. */
export async function setFetchSite(
  ctx: VaultContext,
  tokenId: string,
  site: string,
  level: string,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const key = normalizeSite(site)
  const access = fromSiteLevel(parseSiteLevel(level))
  const existing = await findRule(ctx.vaultId, tokenId, "site", key)
  const shared = existing
    ? null
    : await findRule(ctx.vaultId, ALL_TOKENS, "site", key)

  if (!existing && !shared) {
    await roomForOneMore(ctx.vaultId)
  }

  await db().webFetchRule.upsert({
    where: where(ctx.vaultId, tokenId, "site", key),
    create: {
      id: newId(),
      vaultId: ctx.vaultId,
      tokenId,
      scope: tokenId,
      kind: "site",
      key,
      access,
      // A line the token had through all tokens keeps who first added it.
      addedBy: shared?.addedBy ?? "owner",
      lastFetchedAt: shared?.lastFetchedAt ?? null,
    },
    update: { access },
  })
}

/**
 * The "All tokens" box on a method's or a site's line. Ticked, the level
 * that applies to this token becomes the one for every token, and the
 * token's own line goes (other tokens' own lines still win). Unticked, the
 * line for all tokens goes and this token keeps what it had as its own, so
 * nothing changes for it.
 */
export async function setFetchRuleShared(
  ctx: VaultContext,
  tokenId: string,
  kind: FetchRuleKind,
  rawKey: string,
  shared: boolean,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)

  if (kind !== "method" && kind !== "site") {
    throw invalid("That is neither a method nor a site.")
  }

  const key = kind === "method" ? parseGroup(rawKey) : normalizeSite(rawKey)
  const mine = await findRule(ctx.vaultId, tokenId, kind, key)
  const all = await findRule(ctx.vaultId, ALL_TOKENS, kind, key)
  const governing = mine ?? all

  if (kind === "site" && !governing) {
    throw notFound("That site")
  }

  // A method without a line asks; a site's null follows the methods.
  const access =
    kind === "method"
      ? (asAccess(governing?.access ?? null) ?? "ask")
      : asAccess(governing!.access)
  const vaultId = ctx.vaultId
  const own = { vaultId, scope: tokenId, kind, key }
  const forAll = { vaultId, scope: ALL_TOKENS, kind, key }
  const meta = {
    addedBy: governing?.addedBy ?? "owner",
    lastFetchedAt: governing?.lastFetchedAt ?? null,
  }

  if (shared) {
    await db().$transaction([
      db().webFetchRule.upsert({
        where: where(vaultId, ALL_TOKENS, kind, key),
        create: { id: newId(), ...forAll, tokenId: null, access, ...meta },
        update: { access },
      }),
      db().webFetchRule.deleteMany({ where: own }),
    ])
    return
  }

  // A method at ask needs no line of its own once all tokens have none.
  if (kind === "method" && access === "ask") {
    await db().$transaction([
      db().webFetchRule.deleteMany({ where: forAll }),
      db().webFetchRule.deleteMany({ where: own }),
    ])
    return
  }

  await db().$transaction([
    db().webFetchRule.deleteMany({ where: forAll }),
    db().webFetchRule.upsert({
      where: where(vaultId, tokenId, kind, key),
      create: { id: newId(), ...own, tokenId, access, ...meta },
      update: { access },
    }),
  ])
}

/** A site the owner adds before any assistant has reached for it. */
export async function addFetchSite(
  ctx: VaultContext,
  tokenId: string,
  input: { site: string; level: string; shared: boolean },
): Promise<string> {
  await requireLiveToken(ctx, tokenId)
  const key = normalizeSite(input.site)
  const access = fromSiteLevel(parseSiteLevel(input.level))
  const vaultId = ctx.vaultId
  const mine = await findRule(vaultId, tokenId, "site", key)
  const all = await findRule(vaultId, ALL_TOKENS, "site", key)
  const scope = input.shared ? ALL_TOKENS : tokenId

  if (input.shared ? !all && !mine : !mine) {
    await roomForOneMore(vaultId)
  }

  await db().$transaction([
    db().webFetchRule.upsert({
      where: where(vaultId, scope, "site", key),
      create: {
        id: newId(),
        vaultId,
        tokenId: input.shared ? null : tokenId,
        scope,
        kind: "site",
        key,
        access,
        addedBy: "owner",
      },
      update: { access },
    }),
    // For all tokens, this token's own line would hide it from this token.
    ...(input.shared
      ? [
          db().webFetchRule.deleteMany({
            where: { vaultId, scope: tokenId, kind: "site", key },
          }),
        ]
      : []),
  ])

  return key
}

/**
 * Takes a site off the token's page: its own line, or, when the line it
 * follows is the one for all tokens, that one (for every token). A site an
 * assistant fetches again comes back, following the methods.
 */
export async function removeFetchSite(
  ctx: VaultContext,
  tokenId: string,
  site: string,
): Promise<void> {
  await requireLiveToken(ctx, tokenId)
  const key = normalizeSite(site)
  const own = await db().webFetchRule.deleteMany({
    where: { vaultId: ctx.vaultId, scope: tokenId, kind: "site", key },
  })

  if (own.count > 0) {
    return
  }

  const all = await db().webFetchRule.deleteMany({
    where: { vaultId: ctx.vaultId, scope: ALL_TOKENS, kind: "site", key },
  })

  if (all.count === 0) {
    throw notFound("That site")
  }
}
