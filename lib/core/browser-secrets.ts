import { createHash } from "node:crypto"

import { parse as parseHost } from "tldts"

import { requireToken } from "./api-tokens"
import {
  MAX_SECRET_PURPOSE_CHARS,
  MAX_SECRET_REQUEST_ORIGINS,
  MAX_SECRET_SIGN_IN_WINDOWS,
  SECRET_SIGN_IN_WINDOW_MS,
} from "./browser/limits"
import {
  OwnerNeeded,
  type ProposedSecretSite,
  type SecretPart,
  type SecretRequestAsk,
  type SecretSitesChangeAsk,
  type SecretUseContext,
} from "./browser/types"
import { SECRET_ALLOW_MINUTES } from "./constants"
import type { VaultContext } from "./context"
import { keyedHash } from "./crypto"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { checkPasswordRecipe } from "./generate-password"
import { lookalikeReason } from "./lookalike-sites"
import { hiddenCharacter, withoutPresentation } from "./memories"
import {
  byName,
  SECRET_META_SELECT,
  secretName,
  secretNameWhere,
} from "./secret-meta"
import { openText, sealText, type Sealed } from "./sealed"
import {
  checkLoginName,
  createSecret,
  findOwnerSecretByName,
  isOwnerSecretKind,
  openSecretDetails,
  validateSecretName,
  validateSecretValue,
  type OwnerSecretKind,
} from "./secrets"
import { TOKEN_NAME_SELECT, tokenName } from "./token-names"

/**
 * The owner's secrets in the browser: an assistant's type call names one as
 * {"$secret": name}, and PCP types it into the page, its value never passing
 * through the assistant (lib/core/upstream.ts places it, browser/call.ts
 * types it).
 *
 * Two things decide whether it is typed, both per site, as an origin
 * (https://host[:port]) checked at the moment of typing against the page's
 * own address and the frame the field is in:
 *
 * - The secret's origins (SecretBrowserOrigin): where it belongs. The owner
 *   adds one by "Always allow" on a request, or on the secret's row. An API
 *   endpoint's use of the same secret never counts.
 * - The token's allowance for the secret at that origin
 *   (ApiTokenSecretAllowance): its next use only, for an hour, or always
 *   ("always" only while the origin is the secret's). Without one the call
 *   becomes a `secret_use` request: the secret's name, the site and the tab,
 *   which the owner answers once, for an hour or always.
 *
 * Allowances are like the other "Allow for" ones (lib/core/allowances.ts):
 * read only where the tool's level let the call through, never lifting a
 * block, not exported. Origins are not secret, and are exported.
 *
 * `request_secret` asks the owner to store a new secret for the browser:
 * they type its value on PCP's page, confirm its sites and choose how its
 * uses go; the assistant hears its name. A name PCP holds already is never
 * written over.
 *
 * The names of the secrets bound to a page's site, with the sign-in each
 * belongs to, are what the browser's note of the sign-ins there lists
 * (signInsAt, browser/sign-in-hint.ts); never a value.
 *
 * Nothing here decrypts: secrets.ts does, for upstream.ts (a value) and
 * here (a login name and note, openSecretDetails).
 */

/** A once allowance waits this long for its use. */
export const SECRET_ONCE_MS = 60 * 60_000
export const MAX_SECRET_ORIGINS = MAX_SECRET_REQUEST_ORIGINS
export const MAX_SECRET_PURPOSE = MAX_SECRET_PURPOSE_CHARS

export type SecretUseLevel = "once" | "hour" | "always"

export type TypableSecret = { id: string; name: string; kind: OwnerSecretKind }

/**
 * One of a secret's sites: an origin, and with `subdomains` every origin at
 * the same scheme and port whose host is under this one's, within its
 * registrable domain (siteCovers).
 */
export type SecretSite = { origin: string; subdomains: boolean }

/** What the secret's page and an assistant read for a site. */
export function siteLabel(site: SecretSite): string {
  return site.subdomains ? `${site.origin} and its subdomains` : site.origin
}

/**
 * A page's origin, https://host[:port] as URL.origin writes it; null for
 * one that is not an http(s) page (about:blank, about:srcdoc, data:).
 */
export function originOf(address: string | URL): string | null {
  let url: URL

  try {
    url = typeof address === "string" ? new URL(address) : address
  } catch {
    return null
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null
  }

  return url.origin
}

/**
 * Origins as an assistant or the owner wrote them: each an address whose
 * origin is taken (https://example.com/login reads as https://example.com),
 * at most MAX_SECRET_ORIGINS, no two the same.
 */
export function parseOrigins(list: readonly string[]): string[] {
  const origins: string[] = []

  for (const raw of list) {
    const text = raw.trim()

    if (!text) {
      continue
    }

    let url: URL

    try {
      url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
      )
    } catch {
      throw invalid(`"${text.slice(0, 100)}" is not a site's address.`)
    }

    if (url.username || url.password) {
      throw invalid("A site's address has no user name or password in it.")
    }

    const origin = originOf(url)

    if (!origin) {
      throw invalid(
        `A secret is typed at http:// and https:// sites only, not ${url.protocol}.`,
      )
    }

    if (!origins.includes(origin)) {
      origins.push(origin)
    }
  }

  if (origins.length > MAX_SECRET_ORIGINS) {
    throw invalid(`Name at most ${MAX_SECRET_ORIGINS} sites.`)
  }

  return origins
}

// ---- Subdomains ----------------------------------------------------------------

/**
 * A host's registrable domain by the public suffix list, its private part
 * too (github.io's users, a cloud's buckets are each their own): example.com
 * for login.example.com, example.co.uk for www.example.co.uk. Null for an
 * IP address, a name with no registrable domain (localhost) or a public
 * suffix itself (co.uk, github.io).
 */
export function registrableDomain(host: string): string | null {
  const parsed = parseHost(host, { allowPrivateDomains: true })

  return parsed.isIp ? null : (parsed.domain ?? null)
}

function originParts(origin: string): URL | null {
  try {
    return new URL(origin)
  } catch {
    return null
  }
}

/**
 * Whether a site may stand for its subdomains too: its host has a
 * registrable domain, so "its subdomains" stay within one owner's names.
 * Never an IP address, localhost or a public suffix (co.uk, github.io).
 */
export function canCoverSubdomains(origin: string): boolean {
  const url = originParts(origin)
  return url !== null && registrableDomain(url.hostname) !== null
}

/**
 * Whether a secret's site covers a page's origin: the same origin, or, for a
 * site with subdomains, one at the same scheme and port whose host ends in
 * the site's host and has the same registrable domain. A host under another
 * registrable domain never matches (amazonaws.com does not cover
 * bucket.s3.amazonaws.com, a public suffix of its own), and neither does a
 * name that only ends in the same letters (notexample.com).
 */
export function siteCovers(site: SecretSite, origin: string): boolean {
  if (site.origin === origin) {
    return true
  }

  if (!site.subdomains) {
    return false
  }

  const own = originParts(site.origin)
  const page = originParts(origin)

  if (
    !own ||
    !page ||
    own.protocol !== page.protocol ||
    own.port !== page.port
  ) {
    return false
  }

  const domain = registrableDomain(own.hostname)

  return (
    domain !== null &&
    page.hostname.endsWith(`.${own.hostname}`) &&
    registrableDomain(page.hostname) === domain
  )
}

/**
 * The origins a site with subdomains could have been written as to cover
 * this one: each of its host's parents down to its registrable domain, at
 * the same scheme and port. Empty for a host with no registrable domain.
 */
export function coveringOrigins(origin: string): string[] {
  const url = originParts(origin)
  const domain = url ? registrableDomain(url.hostname) : null

  if (!url || !domain || !url.hostname.endsWith(domain)) {
    return []
  }

  const labels = url.hostname.split(".")
  const port = url.port ? `:${url.port}` : ""
  const parents: string[] = []

  for (let i = 1; i < labels.length; i++) {
    const host = labels.slice(i).join(".")

    if (host.length < domain.length) {
      break
    }

    parents.push(`${url.protocol}//${host}${port}`)
  }

  return parents
}

/**
 * A secret's site is kept as a keyed hash of its origin under the vault's
 * key, the origin itself sealed beside it (#96); a row from before holds
 * the origin in plain text and nothing sealed, so a lookup asks for both.
 */
function originKey(ctx: VaultContext, origin: string): string {
  return keyedHash(ctx.dek, "pcp secret origin", origin)
}

function originAad(secretId: string, key: string): string {
  return `secret_browser_origin:${secretId}:${key}`
}

/** What a row of the secret's site at `origin` stores. */
export function sealedOrigin(
  ctx: VaultContext,
  secretId: string,
  origin: string,
): { origin: string; sealed: Sealed } {
  const key = originKey(ctx, origin)
  return {
    origin: key,
    sealed: sealText(ctx.dek, originAad(secretId, key), origin),
  }
}

/** A site row's origin, opened (or as it was, from before). */
export function openOrigin(
  ctx: VaultContext,
  row: { secretId: string; origin: string; sealed: Uint8Array | null },
): string {
  return openText(
    ctx.dek,
    originAad(row.secretId, row.origin),
    row.sealed,
    row.origin,
  )
}

/** The rows an origin may be kept as. */
function originKeys(ctx: VaultContext, origins: string[]): string[] {
  return [...origins, ...origins.map((origin) => originKey(ctx, origin))]
}

/** The rows that could cover an origin: its own, and its parents' with subdomains. */
function coveringWhere(ctx: VaultContext, origin: string) {
  const parents = coveringOrigins(origin)

  return {
    OR: [
      { origin: { in: originKeys(ctx, [origin]) } },
      ...(parents.length > 0
        ? [
            {
              origin: { in: originKeys(ctx, parents) },
              includeSubdomains: true,
            },
          ]
        : []),
    ],
  }
}

/**
 * A token's allowance for a secret at an origin is kept the same way: the
 * origin as a keyed hash (the row's key), sealed beside it as
 * "api_token_secret_allowance:<token id>:<secret id>:<hash>" (#96). A row
 * from before holds the origin in plain text and nothing sealed.
 */
function allowanceKey(ctx: VaultContext, origin: string): string {
  return keyedHash(ctx.dek, "pcp secret allowance origin", origin)
}

function allowanceAad(tokenId: string, secretId: string, key: string): string {
  return `api_token_secret_allowance:${tokenId}:${secretId}:${key}`
}

/** What a row of a token's allowance for the secret at `origin` stores. */
export function sealedAllowanceOrigin(
  ctx: VaultContext,
  tokenId: string,
  secretId: string,
  origin: string,
): { origin: string; sealed: Sealed } {
  const key = allowanceKey(ctx, origin)
  return {
    origin: key,
    sealed: sealText(ctx.dek, allowanceAad(tokenId, secretId, key), origin),
  }
}

function openAllowanceOrigin(
  ctx: VaultContext,
  row: {
    tokenId: string
    secretId: string
    origin: string
    sealed: Uint8Array | null
  },
): string {
  return openText(
    ctx.dek,
    allowanceAad(row.tokenId, row.secretId, row.origin),
    row.sealed,
    row.origin,
  )
}

/** The rows an allowance's origin may be kept as: its hash, or itself. */
function allowanceOrigins(ctx: VaultContext, origin: string): string[] {
  return [allowanceKey(ctx, origin), origin]
}

/** A secret the browser can type, by its name: one the owner entered. */
export async function findTypableSecret(
  ctx: VaultContext,
  name: string,
): Promise<TypableSecret | null> {
  return findOwnerSecretByName(ctx, name)
}

async function requireTypable(
  ctx: VaultContext,
  secretId: string,
): Promise<TypableSecret> {
  const row = await db().secret.findFirst({
    where: { id: secretId, vaultId: ctx.vaultId },
    select: { ...SECRET_META_SELECT, kind: true },
  })

  if (!row || !isOwnerSecretKind(row.kind)) {
    throw notFound("That secret")
  }

  return { id: row.id, name: secretName(ctx, row), kind: row.kind }
}

// ---- The secret's origins ---------------------------------------------------

/** The most sites one secret has. */
export const MAX_SITES_PER_SECRET = 50

/**
 * Whether the origin is one of the secret's sites: its own, or under one
 * with subdomains (siteCovers).
 */
export async function isBoundOrigin(
  ctx: VaultContext,
  secretId: string,
  origin: string,
): Promise<boolean> {
  const rows = await db().secretBrowserOrigin.findMany({
    where: { secretId, ...coveringWhere(ctx, origin) },
    select: {
      secretId: true,
      origin: true,
      sealed: true,
      includeSubdomains: true,
    },
  })

  return rows.some((row) =>
    siteCovers(
      { origin: openOrigin(ctx, row), subdomains: row.includeSubdomains },
      origin,
    ),
  )
}

function byOrigin(a: SecretSite, b: SecretSite): number {
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0
}

/** A secret's sites, as they are now. */
export async function sitesOf(
  ctx: VaultContext,
  secretId: string,
): Promise<SecretSite[]> {
  const rows = await db().secretBrowserOrigin.findMany({
    where: { secretId },
    select: {
      secretId: true,
      origin: true,
      sealed: true,
      includeSubdomains: true,
    },
  })

  return rows
    .map((row) => ({
      origin: openOrigin(ctx, row),
      subdomains: row.includeSubdomains,
    }))
    .sort(byOrigin)
}

/**
 * Every token's allowance for the secret at origins that `before` covered
 * and `after` does not, gone: a site taken away, or one that no longer
 * stands for its subdomains, asks the owner again there.
 */
async function dropUncoveredAllowances(
  ctx: VaultContext,
  secretId: string,
  before: SecretSite[],
  after: SecretSite[],
): Promise<void> {
  const allowances = await db().apiTokenSecretAllowance.findMany({
    where: { secretId },
    select: { tokenId: true, secretId: true, origin: true, sealed: true },
  })
  // By the row's own key: its hash, or the origin from before.
  const gone = [
    ...new Set(
      allowances
        .filter((allowance) => {
          const origin = openAllowanceOrigin(ctx, allowance)
          return (
            before.some((site) => siteCovers(site, origin)) &&
            !after.some((site) => siteCovers(site, origin))
          )
        })
        .map((allowance) => allowance.origin),
    ),
  ]

  if (gone.length > 0) {
    await db().apiTokenSecretAllowance.deleteMany({
      where: { secretId, origin: { in: gone } },
    })
  }
}

/**
 * Adds a site where the browser may type the secret. `subdomains` makes it
 * stand for its subdomains too (only where it has a registrable domain), or
 * no longer; left out, a site it has keeps what it had.
 */
export async function bindOrigin(
  ctx: VaultContext,
  secretId: string,
  rawOrigin: string,
  { subdomains }: { subdomains?: boolean } = {},
): Promise<string> {
  await requireTypable(ctx, secretId)
  const [origin] = parseOrigins([rawOrigin])

  if (!origin) {
    throw invalid("Enter the site's address, like https://example.com.")
  }

  if (subdomains && !canCoverSubdomains(origin)) {
    throw invalid(
      `${origin} cannot stand for its subdomains: that is for a site's own domain (example.com), never an IP address, localhost or a suffix shared by many owners (co.uk, github.io).`,
    )
  }

  const before = await sitesOf(ctx, secretId)
  const known = before.find((site) => site.origin === origin)

  if (!known && before.length >= MAX_SITES_PER_SECRET) {
    throw invalid(`A secret has at most ${MAX_SITES_PER_SECRET} sites.`)
  }

  const sealed = sealedOrigin(ctx, secretId, origin)
  const includeSubdomains = subdomains ?? known?.subdomains ?? false

  await db().$transaction([
    // One from before, in plain text, gives way to the sealed one.
    db().secretBrowserOrigin.deleteMany({ where: { secretId, origin } }),
    db().secretBrowserOrigin.upsert({
      where: { secretId_origin: { secretId, origin: sealed.origin } },
      create: { secretId, ...sealed, includeSubdomains },
      update: { includeSubdomains },
    }),
  ])

  if (known?.subdomains && subdomains === false) {
    await dropUncoveredAllowances(
      ctx,
      secretId,
      before,
      await sitesOf(ctx, secretId),
    )
  }

  return origin
}

/**
 * Takes a site away from the secret, and every token's allowance for it
 * there (and at its subdomains, where it stood for them and no other site
 * does): its next use there asks the owner again.
 */
export async function unbindOrigin(
  ctx: VaultContext,
  secretId: string,
  origin: string,
): Promise<void> {
  await requireTypable(ctx, secretId)
  const before = await sitesOf(ctx, secretId)
  endSignInWindows(null, secretId)

  await db().$transaction([
    db().secretBrowserOrigin.deleteMany({
      where: { secretId, origin: { in: originKeys(ctx, [origin]) } },
    }),
    db().apiTokenSecretAllowance.deleteMany({
      where: { secretId, origin: { in: allowanceOrigins(ctx, origin) } },
    }),
  ])
  await dropUncoveredAllowances(
    ctx,
    secretId,
    before,
    await sitesOf(ctx, secretId),
  )
}

/** Each of the vault's secrets' sites, by secret id. */
export async function listBrowserOrigins(
  ctx: VaultContext,
): Promise<Map<string, SecretSite[]>> {
  const rows = await db().secretBrowserOrigin.findMany({
    where: { secret: { vaultId: ctx.vaultId } },
    select: {
      secretId: true,
      origin: true,
      sealed: true,
      includeSubdomains: true,
    },
  })
  const bySecret = new Map<string, SecretSite[]>()

  for (const row of rows) {
    bySecret.set(row.secretId, [
      ...(bySecret.get(row.secretId) ?? []),
      { origin: openOrigin(ctx, row), subdomains: row.includeSubdomains },
    ])
  }

  for (const sites of bySecret.values()) {
    sites.sort(byOrigin)
  }

  return bySecret
}

/**
 * A secret the owner bound to a site, as the browser names it to an
 * assistant on a page there: its name and the sign-in it belongs to, never
 * its value.
 */
export type SiteSignIn = {
  name: string
  kind: OwnerSecretKind
  loginName: string | null
  note: string | null
  /** The TOTP secret whose code goes with it, by name. */
  totp: string | null
}

/**
 * The owner's secrets bound to an origin, for the browser's note of the
 * sign-ins at a page's site (browser/sign-in-hint.ts): each text secret
 * with its login name, note and TOTP companion, then each TOTP secret bound
 * there that is none of theirs' companion. At most `max`. Naming them gives
 * no right to them: typing one is still the gate's (admitSecretUse).
 */
export async function signInsAt(
  ctx: VaultContext,
  origin: string,
  max: number,
): Promise<SiteSignIn[]> {
  const rows = await db().secret.findMany({
    where: {
      vaultId: ctx.vaultId,
      kind: { in: ["text", "totp"] },
      browserOrigins: { some: coveringWhere(ctx, origin) },
    },
    orderBy: { kind: "asc" },
    select: {
      ...SECRET_META_SELECT,
      kind: true,
      loginName: true,
      note: true,
      totpCompanion: { select: SECRET_META_SELECT },
    },
  })
  const named = rows
    .map((row) => ({
      ...row,
      name: secretName(ctx, row),
      totp: row.totpCompanion ? secretName(ctx, row.totpCompanion) : null,
    }))
    // By kind, then name: sorted here, since the names are sealed.
    .sort((a, b) =>
      a.kind === b.kind ? byName(a, b) : a.kind < b.kind ? -1 : 1,
    )
  const companions = new Set(
    named.flatMap((row) => (row.totp ? [row.totp] : [])),
  )

  return named
    .filter((row) => row.kind === "text" || !companions.has(row.name))
    .slice(0, max)
    .map((row) => ({
      name: row.name,
      kind: row.kind as OwnerSecretKind,
      ...openSecretDetails(ctx, row),
      totp: row.totp,
    }))
}

// ---- Allowances ---------------------------------------------------------------

/**
 * Lets one token have the secret typed at one origin: its next use only
 * (within SECRET_ONCE_MS), for SECRET_ALLOW_MINUTES, or always, which adds
 * the origin to the secret's too. A later answer replaces an earlier one.
 */
export async function grantSecretUse(
  ctx: VaultContext,
  {
    tokenId,
    secretId,
    origin,
    level,
  }: {
    tokenId: string
    secretId: string
    origin: string
    level: SecretUseLevel
  },
  now = new Date(),
): Promise<void> {
  await requireToken(ctx, tokenId)
  await requireTypable(ctx, secretId)

  if (originOf(origin) !== origin) {
    throw invalid("A secret's site is an origin, like https://example.com.")
  }

  if (level === "always") {
    await bindOrigin(ctx, secretId, origin)
  }

  const until =
    level === "always"
      ? null
      : new Date(
          now.getTime() +
            (level === "once" ? SECRET_ONCE_MS : SECRET_ALLOW_MINUTES * 60_000),
        )
  const data = { until, once: level === "once" }
  const sealed = sealedAllowanceOrigin(ctx, tokenId, secretId, origin)

  await db().$transaction([
    // One from before, in plain text, gives way to the sealed one.
    db().apiTokenSecretAllowance.deleteMany({
      where: { tokenId, secretId, origin },
    }),
    db().apiTokenSecretAllowance.upsert({
      where: {
        tokenId_secretId_origin: { tokenId, secretId, origin: sealed.origin },
      },
      create: { tokenId, secretId, ...sealed, ...data },
      update: data,
    }),
  ])
}

/**
 * Whether the token may have the secret typed at the origin now, using up
 * a once allowance if that is what it has. An "always" holds only while
 * the origin is the secret's.
 */
export async function takeSecretUse(
  ctx: VaultContext,
  target: { tokenId: string; secretId: string; origin: string },
  now = new Date(),
): Promise<boolean> {
  return (await takeAllowance(ctx, target, now)) !== false
}

/** takeSecretUse, saying whether what it used was a once allowance. */
async function takeAllowance(
  ctx: VaultContext,
  {
    tokenId,
    secretId,
    origin,
  }: { tokenId: string; secretId: string; origin: string },
  now: Date,
): Promise<false | "once" | "lasting"> {
  const keys = allowanceOrigins(ctx, origin)
  const row = await db().apiTokenSecretAllowance.findFirst({
    where: { tokenId, secretId, origin: { in: keys } },
  })

  if (!row) {
    return false
  }

  if (row.until === null) {
    return (await isBoundOrigin(ctx, secretId, origin)) ? "lasting" : false
  }

  if (row.until.getTime() <= now.getTime()) {
    return false
  }

  if (!row.once) {
    return "lasting"
  }

  // One use, however many calls race for it.
  const taken = await db().apiTokenSecretAllowance.deleteMany({
    where: {
      tokenId,
      secretId,
      origin: row.origin,
      once: true,
      until: { gt: now },
    },
  })

  return taken.count === 1 ? "once" : false
}

// ---- One sign-in on a once allowance ------------------------------------------

/**
 * A secret's login name and password are one credential, so a once
 * allowance is one sign-in: when one part is typed on it, the other part
 * may follow once, by the same token, in the same tab at the same site,
 * within SECRET_SIGN_IN_WINDOW_MS. Kept in memory only (a restart asks
 * again), each window used up by that one other part, so a second sign-in
 * asks the owner again.
 */
const signInWindows = new Map<string, { part: SecretPart; until: number }>()

function windowKey(
  tokenId: string,
  secretId: string,
  origin: string,
  tabId: string,
): string {
  return [tokenId, secretId, origin, tabId].join("\n")
}

function openSignInWindow(key: string, part: SecretPart, now: Date): void {
  for (const [other, window] of signInWindows) {
    if (window.until <= now.getTime()) signInWindows.delete(other)
  }

  while (signInWindows.size >= MAX_SECRET_SIGN_IN_WINDOWS) {
    signInWindows.delete(signInWindows.keys().next().value!)
  }

  signInWindows.set(key, {
    part,
    until: now.getTime() + SECRET_SIGN_IN_WINDOW_MS,
  })
}

/** The other part of a sign-in begun on a once allowance, used up if so. */
function takeSignInWindow(key: string, part: SecretPart, now: Date): boolean {
  const window = signInWindows.get(key)

  if (!window || window.until <= now.getTime() || window.part === part) {
    return false
  }

  signInWindows.delete(key)
  return true
}

/** Sign-ins begun for these, ended: the owner took the allowance or the site away. */
function endSignInWindows(tokenId: string | null, secretId: string): void {
  for (const key of signInWindows.keys()) {
    const [token, secret] = key.split("\n")
    if (secret === secretId && (tokenId === null || token === tokenId)) {
      signInWindows.delete(key)
    }
  }
}

/** A once allowance the call it was given for did not use, gone. */
export async function dropOnceAllowance(
  ctx: VaultContext,
  {
    tokenId,
    secretId,
    origin,
  }: {
    tokenId: string
    secretId: string
    origin: string
  },
): Promise<void> {
  await db().apiTokenSecretAllowance.deleteMany({
    where: {
      tokenId,
      secretId,
      origin: { in: allowanceOrigins(ctx, origin) },
      once: true,
    },
  })
}

export type SecretAllowance = {
  tokenId: string
  tokenName: string
  secretId: string
  secretName: string
  origin: string
  /** Null: always. */
  until: Date | null
  once: boolean
}

/**
 * The allowances in force, for a token's page or the Secrets page: the
 * ones that have not run out, "always" last.
 */
export async function listSecretAllowances(
  ctx: VaultContext,
  filter: { tokenId?: string; secretId?: string } = {},
  now = new Date(),
): Promise<SecretAllowance[]> {
  const rows = await db().apiTokenSecretAllowance.findMany({
    where: {
      ...filter,
      token: { vaultId: ctx.vaultId },
      OR: [{ until: null }, { until: { gt: now } }],
    },
    include: {
      token: { select: TOKEN_NAME_SELECT },
      secret: { select: SECRET_META_SELECT },
    },
  })

  return rows
    .map((row) => ({
      tokenId: row.tokenId,
      tokenName: tokenName(ctx, row.token),
      secretId: row.secretId,
      secretName: secretName(ctx, row.secret),
      origin: openAllowanceOrigin(ctx, row),
      until: row.until,
      once: row.once,
    }))
    .sort(
      (a, b) =>
        (a.until?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.until?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0),
    )
}

/** The owner ends one: that token's next use there asks them again. */
export async function endSecretAllowance(
  ctx: VaultContext,
  target: { tokenId: string; secretId: string; origin: string },
): Promise<void> {
  await requireToken(ctx, target.tokenId)
  await requireTypable(ctx, target.secretId)
  await db().apiTokenSecretAllowance.deleteMany({
    where: {
      tokenId: target.tokenId,
      secretId: target.secretId,
      origin: { in: allowanceOrigins(ctx, target.origin) },
    },
  })
  endSignInWindows(target.tokenId, target.secretId)
}

// ---- The gate -----------------------------------------------------------------

/**
 * The one place a secret is let into a page (upstream.ts, for every way a
 * type call comes: call_tool, run_code, a wrapper or flow, an answer the
 * owner gave): the secret the call names, if the token may have it typed
 * where `use` says the field is. Otherwise the owner is asked (OwnerNeeded,
 * a `secret_use` request), or the call is refused.
 */
export async function admitSecretUse(
  ctx: VaultContext,
  {
    tokenId,
    serverId,
    name,
    use,
    part = "password",
  }: {
    tokenId: string
    serverId: string
    name: string
    use: SecretUseContext
    /** The login name goes through the same gate as the value. */
    part?: SecretPart
  },
  now = new Date(),
): Promise<TypableSecret> {
  const secret = await findTypableSecret(ctx, name)

  if (!secret) {
    throw new PcpError(
      "not_found",
      `There is no secret called "${name}" that the browser can type. request_secret asks the owner to add one.`,
    )
  }

  if (originOf(use.origin) !== use.origin) {
    throw invalid("A secret is typed only into a page at an http(s) site.")
  }

  const key = windowKey(tokenId, secret.id, use.origin, use.tabId)

  if (takeSignInWindow(key, part, now)) {
    return secret
  }

  const taken = await takeAllowance(
    ctx,
    { tokenId, secretId: secret.id, origin: use.origin },
    now,
  )

  if (taken === "once") {
    openSignInWindow(key, part, now)
  }

  if (taken) {
    return secret
  }

  throw new OwnerNeeded({
    kind: "secret_use",
    input: {
      serverId,
      tabId: use.tabId,
      secretName: secret.name,
      origin: use.origin,
      url: use.url,
      title: use.title,
      field: use.field,
      call: use.call,
      ...(part === "username" ? { part } : {}),
    },
  })
}

// ---- request_secret -----------------------------------------------------------

/**
 * request_secret's arguments, checked before the owner is asked: a name
 * PCP holds already is refused (the browser types that one; nothing an
 * assistant asks for writes over it), and so is a purpose with characters
 * that do not show on screen.
 */
export async function checkSecretRequest(
  ctx: VaultContext,
  serverId: string,
  args: {
    name: string
    purpose: string
    origins: string[]
    kind?: string
    username?: string
    generate?: unknown
  },
): Promise<SecretRequestAsk> {
  const name = args.name.trim()
  const nameProblem = validateSecretName(name)

  if (nameProblem) {
    throw invalid(`The secret's name: ${nameProblem}`)
  }

  const purpose = withoutPresentation(args.purpose).trim()
  const hidden = hiddenCharacter(purpose)

  if (!purpose) {
    throw invalid("Say what the secret is for, in purpose.")
  }

  if (hidden) {
    throw invalid(
      `The purpose has a character that does not show on screen (${hidden}); write it in plain text.`,
    )
  }

  if (purpose.length > MAX_SECRET_PURPOSE) {
    throw invalid(`Keep the purpose under ${MAX_SECRET_PURPOSE} characters.`)
  }

  const origins = parseOrigins(args.origins)

  if (origins.length === 0) {
    throw invalid("Name the sites the secret is typed at, in origins.")
  }

  const kind = args.kind === "totp" ? "totp" : "text"

  if (kind === "totp" && (args.username || args.generate)) {
    throw invalid(
      "A one-time codes secret takes neither username nor generate: its seed comes from the site.",
    )
  }

  const username = checkLoginName(args.username)
  const generate =
    args.generate === undefined ? null : checkPasswordRecipe(args.generate)

  const existing = await db().secret.findFirst({
    where: secretNameWhere(ctx, name),
    select: { kind: true },
  })

  if (existing) {
    throw new PcpError(
      "conflict",
      isOwnerSecretKind(existing.kind)
        ? `The owner already has a secret called "${name}", and PCP never writes over one: type it with text {"$secret": "${name}"}. Its first use at a site where this token may not type it yet asks the owner.`
        : `There is a secret called "${name}" already, and the browser does not type it. Choose another name.`,
    )
  }

  return {
    serverId,
    name,
    purpose,
    origins,
    kind,
    ...(username ? { username } : {}),
    ...(generate ? { generate } : {}),
  }
}

/**
 * What is wrong with the owner's answer to request_secret before anything
 * is written, so they can fix it on the page: the sites, and the value
 * (none, when they added a secret by that name since; one that makes codes,
 * for one-time codes). Null when it will do.
 */
export async function checkSecretAnswer(
  ctx: VaultContext,
  ask: SecretRequestAsk,
  {
    value,
    origins,
    loginName,
  }: { value?: string; origins?: string[]; loginName?: string },
): Promise<string | null> {
  let parsed: string[]

  try {
    parsed = parseOrigins(origins ?? ask.origins)
  } catch (error) {
    if (error instanceof PcpError) {
      return error.message
    }

    throw error
  }

  if (parsed.length === 0) {
    return "Leave at least one site where the secret is typed."
  }

  if (await findTypableSecret(ctx, ask.name)) {
    return value
      ? `A secret called "${ask.name}" exists now, and nothing is written over it. Leave the value empty to use it.`
      : null
  }

  const other = await db().secret.findFirst({
    where: secretNameWhere(ctx, ask.name),
    select: { id: true },
  })

  if (other) {
    return `A secret called "${ask.name}" exists now that the browser does not type, so this one cannot be saved by that name.`
  }

  if (ask.kind === "text") {
    try {
      checkLoginName(loginName)
    } catch (error) {
      if (error instanceof PcpError) {
        return error.message
      }

      throw error
    }
  }

  return validateSecretValue(value ?? "", ask.kind)
}

/**
 * The owner's answer to request_secret: the secret saved with the value
 * they typed (or, when they added one by that name since, that one, never
 * written over), the sites they left in it, and the requesting token's
 * uses at each, as they chose. Says what was done, never the value.
 */
export async function applySecretRequest(
  ctx: VaultContext,
  tokenId: string,
  ask: SecretRequestAsk,
  {
    value,
    origins: chosen,
    level,
    loginName,
    generated = false,
  }: {
    value?: string
    origins?: string[]
    level: SecretUseLevel
    /** The login name the owner left on the page (a text secret's). */
    loginName?: string
    /** The value is one PCP made, on the owner's Generate. */
    generated?: boolean
  },
): Promise<string> {
  const origins = parseOrigins(chosen ?? ask.origins)

  if (origins.length === 0) {
    throw invalid("Leave at least one site where the secret is typed.")
  }

  let secret = await findTypableSecret(ctx, ask.name)
  let login: string | null = null

  if (secret) {
    if (value) {
      throw new PcpError(
        "conflict",
        `A secret called "${ask.name}" exists now, and nothing is written over it. Leave the value empty to use it.`,
      )
    }
  } else {
    const problem = validateSecretValue(value ?? "", ask.kind)

    if (problem) {
      throw invalid(problem)
    }

    const { id } = await createSecret(ctx, {
      name: ask.name,
      value: value!,
      description: ask.purpose.slice(0, MAX_SECRET_PURPOSE),
      kind: ask.kind,
      ...(ask.kind === "text" ? { loginName: loginName ?? null } : {}),
    })
    secret = { id, name: ask.name, kind: ask.kind }
    login = ask.kind === "text" ? checkLoginName(loginName) : null
  }

  for (const origin of origins) {
    await bindOrigin(ctx, secret.id, origin)
    await grantSecretUse(ctx, { tokenId, secretId: secret.id, origin, level })
  }

  const where = origins.join(", ")
  const uses =
    level === "always"
      ? "This token may have it typed there whenever it asks."
      : level === "hour"
        ? "This token may have it typed there for the next hour; after that each use asks the owner."
        : "This token may have it typed there once; after that each use asks the owner."

  const made = generated
    ? " PCP made its value itself (a new password, which the owner can see on the Secrets page); use it where the site asks for a new password."
    : ""
  const withLogin = login
    ? ` Its login name, ${login}, is kept with it: type that with {"$secret": "${secret.name}", "part": "username"}.`
    : ""

  return `The owner saved the secret "${secret.name}"${secret.kind === "totp" ? " (one-time codes: the code of the moment is typed)" : ""} for ${where}. Type it with type's text {"$secret": "${secret.name}"} into a field on a page there; you never see its value.${made}${withLogin} ${uses}`
}

// ---- update_secret_sites ------------------------------------------------------

/**
 * A key for a secret's sites as the owner read them, so their answer to a
 * change applies only to the list they saw (applySecretSitesChange).
 */
export function sitesBasis(sites: readonly SecretSite[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...sites]
          .sort((a, b) => a.origin.localeCompare(b.origin))
          .map((site) => [site.origin, site.subdomains]),
      ),
    )
    .digest("base64url")
    .slice(0, 22)
}

function hostOf(origin: string): string {
  return originParts(origin)?.hostname ?? origin
}

/**
 * update_secret_sites's arguments, checked before the owner is asked: one of
 * the owner's secrets the browser types, a reason in plain text, sites to
 * add (each with subdomains only where that can be) and sites it has to
 * take away, and at least one of them a change.
 */
export async function checkSecretSitesChange(
  ctx: VaultContext,
  serverId: string,
  args: {
    name: string
    reason: string
    add?: Array<{ origin: string; subdomains?: boolean }>
    remove?: string[]
  },
): Promise<SecretSitesChangeAsk> {
  const secret = await findTypableSecret(ctx, args.name.trim())

  if (!secret) {
    throw new PcpError(
      "not_found",
      `There is no secret called "${args.name.trim()}" that the browser types. request_secret asks the owner for a new one.`,
    )
  }

  const reason = withoutPresentation(args.reason).trim()
  const hidden = hiddenCharacter(reason)

  if (!reason) {
    throw invalid("Say why the sites should change, in reason.")
  }

  if (hidden) {
    throw invalid(
      `The reason has a character that does not show on screen (${hidden}); write it in plain text.`,
    )
  }

  if (reason.length > MAX_SECRET_PURPOSE) {
    throw invalid(`Keep the reason under ${MAX_SECRET_PURPOSE} characters.`)
  }

  const current = await sitesOf(ctx, secret.id)
  const add: ProposedSecretSite[] = []

  for (const entry of args.add ?? []) {
    const [origin] = parseOrigins([entry.origin])

    if (!origin) {
      throw invalid("Each site to add is an address, like https://example.com.")
    }

    const subdomains = entry.subdomains === true

    if (subdomains && !canCoverSubdomains(origin)) {
      throw invalid(
        `${origin} cannot stand for its subdomains: only a site's own domain can (example.com), never an IP address, localhost or a suffix many owners share (co.uk, github.io).`,
      )
    }

    if (add.some((site) => site.origin === origin)) {
      throw invalid(`${origin} is named twice in add.`)
    }

    add.push({ origin, subdomains })
  }

  const remove = parseOrigins(args.remove ?? [])

  for (const origin of remove) {
    if (!current.some((site) => site.origin === origin)) {
      throw invalid(
        `${origin} is not one of the sites of "${secret.name}"${current.length > 0 ? `: they are ${current.map(siteLabel).join(", ")}` : ", which has none"}.`,
      )
    }

    if (add.some((site) => site.origin === origin)) {
      throw invalid(`${origin} is both added and taken away.`)
    }
  }

  const changes = add.filter(
    (site) =>
      !current.some(
        (known) =>
          known.origin === site.origin && known.subdomains === site.subdomains,
      ),
  )

  if (changes.length === 0 && remove.length === 0) {
    throw invalid(
      `Nothing would change: "${secret.name}" is typed at ${current.map(siteLabel).join(", ") || "no site yet"}.`,
    )
  }

  const after =
    current.length -
    remove.length +
    changes.filter(
      (site) => !current.some((known) => known.origin === site.origin),
    ).length

  if (after > MAX_SITES_PER_SECRET) {
    throw invalid(`A secret has at most ${MAX_SITES_PER_SECRET} sites.`)
  }

  return { serverId, secretName: secret.name, reason, add: changes, remove }
}

/** One change on the request's page, for the owner to tick or leave. */
export type SecretSiteChangeShown = {
  /** "add:<origin>" or "remove:<origin>": what the owner's answer names. */
  key: string
  action: "add" | "remove"
  origin: string
  subdomains: boolean
  label: string
  /** Why it looks like one of the secret's sites without being it. */
  lookalike: string | null
  /** A registrable domain none of the secret's sites has. */
  newDomain: boolean
  /** Already so (a site added since, or one taken away since). */
  noop: boolean
}

export type SecretSitesShown = {
  secretName: string
  /** False once the secret is gone: nothing can be applied. */
  exists: boolean
  current: SecretSite[]
  changes: SecretSiteChangeShown[]
  /** The sites as shown (sitesBasis), which the owner's answer sends back. */
  basis: string
}

/** A site change as the owner reads it: the sites now, and each change. */
export async function showSecretSitesChange(
  ctx: VaultContext,
  ask: SecretSitesChangeAsk,
): Promise<SecretSitesShown> {
  const secret = await findTypableSecret(ctx, ask.secretName)
  const current = secret ? await sitesOf(ctx, secret.id) : []
  const known = current.map((site) => {
    const host = hostOf(site.origin)
    return { host, domain: registrableDomain(host) }
  })

  return {
    secretName: ask.secretName,
    exists: secret !== null,
    current,
    basis: sitesBasis(current),
    changes: [
      ...ask.add.map((site): SecretSiteChangeShown => {
        const host = hostOf(site.origin)
        const domain = registrableDomain(host)
        const now = current.find((known) => known.origin === site.origin)

        return {
          key: `add:${site.origin}`,
          action: "add",
          origin: site.origin,
          subdomains: site.subdomains,
          label: siteLabel(site),
          lookalike: lookalikeReason(host, domain, known),
          newDomain:
            known.length > 0 &&
            !known.some(
              (other) => (other.domain ?? other.host) === (domain ?? host),
            ),
          noop: now !== undefined && now.subdomains === site.subdomains,
        }
      }),
      ...ask.remove.map((origin): SecretSiteChangeShown => ({
        key: `remove:${origin}`,
        action: "remove",
        origin,
        subdomains: false,
        label: origin,
        lookalike: null,
        newDomain: false,
        noop: !current.some((known) => known.origin === origin),
      })),
    ],
  }
}

/**
 * What is wrong with the owner's answer to update_secret_sites before
 * anything is written, so they can read the page again or tick something:
 * the secret gone, its sites changed since they were shown (`basis`), a
 * change that was not asked for, or none ticked. Null when it will do.
 */
export async function checkSecretSitesAnswer(
  ctx: VaultContext,
  ask: SecretSitesChangeAsk,
  { basis, keep }: { basis?: string; keep?: string[] },
): Promise<string | null> {
  const secret = await findTypableSecret(ctx, ask.secretName)

  if (!secret) {
    return `The secret "${ask.secretName}" is no longer in PCP, so there is nothing to change.`
  }

  if (basis !== sitesBasis(await sitesOf(ctx, secret.id))) {
    return `The sites of "${secret.name}" changed since this page was opened, so nothing was changed. Read it again, then answer.`
  }

  const chosen = keep ?? []

  if (
    chosen.some(
      (key) =>
        !ask.add.some((site) => `add:${site.origin}` === key) &&
        !ask.remove.some((origin) => `remove:${origin}` === key),
    )
  ) {
    return "That is not one of the changes asked for."
  }

  return chosen.length === 0
    ? "Tick at least one change, or answer Not now."
    : null
}

/**
 * The owner's answer to update_secret_sites: the changes they ticked
 * (`keep`, by key), made to the secret's sites as they were shown them
 * (`basis`); refused, with nothing written, when the sites changed since.
 * A site taken away takes every token's allowance there with it. Says what
 * was done; the value is never part of it.
 */
export async function applySecretSitesChange(
  ctx: VaultContext,
  ask: SecretSitesChangeAsk,
  answer: { basis?: string; keep?: string[] },
): Promise<string> {
  const problem = await checkSecretSitesAnswer(ctx, ask, answer)

  if (problem) {
    throw new PcpError("conflict", problem)
  }

  const secret = (await findTypableSecret(ctx, ask.secretName))!
  const chosen = new Set(answer.keep ?? [])
  const added: string[] = []
  const removed: string[] = []
  const left: string[] = []

  for (const origin of ask.remove) {
    if (chosen.has(`remove:${origin}`)) {
      await unbindOrigin(ctx, secret.id, origin)
      removed.push(origin)
    } else {
      left.push(`taking away ${origin}`)
    }
  }

  for (const site of ask.add) {
    if (chosen.has(`add:${site.origin}`)) {
      await bindOrigin(ctx, secret.id, site.origin, {
        subdomains: site.subdomains,
      })
      added.push(siteLabel(site))
    } else {
      left.push(`adding ${siteLabel(site)}`)
    }
  }

  const now = (await sitesOf(ctx, secret.id)).map(siteLabel)

  return [
    `The owner changed where "${secret.name}" is typed.`,
    ...(added.length > 0 ? [`Added: ${added.join(", ")}.`] : []),
    ...(removed.length > 0 ? [`Taken away: ${removed.join(", ")}.`] : []),
    ...(left.length > 0 ? [`Not done: ${left.join("; ")}.`] : []),
    `Its sites now: ${now.join(", ") || "none"}. A token's first use at a site still asks the owner, unless it may already type it there.`,
  ].join(" ")
}
