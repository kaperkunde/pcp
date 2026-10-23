import { requireToken } from "./api-tokens"
import {
  MAX_SECRET_PURPOSE_CHARS,
  MAX_SECRET_REQUEST_ORIGINS,
} from "./browser/limits"
import {
  OwnerNeeded,
  type SecretRequestAsk,
  type SecretUseContext,
} from "./browser/types"
import { SECRET_ALLOW_MINUTES } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { hiddenCharacter, withoutPresentation } from "./memories"
import {
  createSecret,
  findOwnerSecretByName,
  isOwnerSecretKind,
  validateSecretName,
  validateSecretValue,
  type OwnerSecretKind,
} from "./secrets"

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
 * Nothing here decrypts: secrets.ts does, for upstream.ts.
 */

/** A once allowance waits this long for its use. */
export const SECRET_ONCE_MS = 60 * 60_000
export const MAX_SECRET_ORIGINS = MAX_SECRET_REQUEST_ORIGINS
export const MAX_SECRET_PURPOSE = MAX_SECRET_PURPOSE_CHARS

export type SecretUseLevel = "once" | "hour" | "always"

export type TypableSecret = { id: string; name: string; kind: OwnerSecretKind }

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
    select: { id: true, name: true, kind: true },
  })

  if (!row || !isOwnerSecretKind(row.kind)) {
    throw notFound("That secret")
  }

  return { id: row.id, name: row.name, kind: row.kind }
}

// ---- The secret's origins ---------------------------------------------------

export async function isBoundOrigin(
  secretId: string,
  origin: string,
): Promise<boolean> {
  return (
    (await db().secretBrowserOrigin.findUnique({
      where: { secretId_origin: { secretId, origin } },
      select: { origin: true },
    })) !== null
  )
}

/** Adds a site where the browser may type the secret. */
export async function bindOrigin(
  ctx: VaultContext,
  secretId: string,
  rawOrigin: string,
): Promise<string> {
  await requireTypable(ctx, secretId)
  const [origin] = parseOrigins([rawOrigin])

  if (!origin) {
    throw invalid("Enter the site's address, like https://example.com.")
  }

  const count = await db().secretBrowserOrigin.count({ where: { secretId } })
  const known = await isBoundOrigin(secretId, origin)

  if (!known && count >= 50) {
    throw invalid("A secret has at most 50 sites.")
  }

  await db().secretBrowserOrigin.upsert({
    where: { secretId_origin: { secretId, origin } },
    create: { secretId, origin },
    update: {},
  })

  return origin
}

/**
 * Takes a site away from the secret, and every token's allowance for it
 * there: its next use there asks the owner again.
 */
export async function unbindOrigin(
  ctx: VaultContext,
  secretId: string,
  origin: string,
): Promise<void> {
  await requireTypable(ctx, secretId)
  await db().$transaction([
    db().secretBrowserOrigin.deleteMany({ where: { secretId, origin } }),
    db().apiTokenSecretAllowance.deleteMany({ where: { secretId, origin } }),
  ])
}

/** Each of the vault's secrets' sites, by secret id. */
export async function listBrowserOrigins(
  ctx: VaultContext,
): Promise<Map<string, string[]>> {
  const rows = await db().secretBrowserOrigin.findMany({
    where: { secret: { vaultId: ctx.vaultId } },
    orderBy: [{ origin: "asc" }],
    select: { secretId: true, origin: true },
  })
  const bySecret = new Map<string, string[]>()

  for (const row of rows) {
    bySecret.set(row.secretId, [
      ...(bySecret.get(row.secretId) ?? []),
      row.origin,
    ])
  }

  return bySecret
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

  await db().apiTokenSecretAllowance.upsert({
    where: { tokenId_secretId_origin: { tokenId, secretId, origin } },
    create: { tokenId, secretId, origin, ...data },
    update: data,
  })
}

/**
 * Whether the token may have the secret typed at the origin now, using up
 * a once allowance if that is what it has. An "always" holds only while
 * the origin is the secret's.
 */
export async function takeSecretUse(
  {
    tokenId,
    secretId,
    origin,
  }: { tokenId: string; secretId: string; origin: string },
  now = new Date(),
): Promise<boolean> {
  const row = await db().apiTokenSecretAllowance.findUnique({
    where: { tokenId_secretId_origin: { tokenId, secretId, origin } },
  })

  if (!row) {
    return false
  }

  if (row.until === null) {
    return isBoundOrigin(secretId, origin)
  }

  if (row.until.getTime() <= now.getTime()) {
    return false
  }

  if (!row.once) {
    return true
  }

  // One use, however many calls race for it.
  const taken = await db().apiTokenSecretAllowance.deleteMany({
    where: { tokenId, secretId, origin, once: true, until: { gt: now } },
  })

  return taken.count === 1
}

/** A once allowance the call it was given for did not use, gone. */
export async function dropOnceAllowance({
  tokenId,
  secretId,
  origin,
}: {
  tokenId: string
  secretId: string
  origin: string
}): Promise<void> {
  await db().apiTokenSecretAllowance.deleteMany({
    where: { tokenId, secretId, origin, once: true },
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
      token: { select: { name: true } },
      secret: { select: { name: true } },
    },
  })

  return rows
    .map((row) => ({
      tokenId: row.tokenId,
      tokenName: row.token.name,
      secretId: row.secretId,
      secretName: row.secret.name,
      origin: row.origin,
      until: row.until,
      once: row.once,
    }))
    .sort(
      (a, b) =>
        (a.until?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (b.until?.getTime() ?? Number.MAX_SAFE_INTEGER),
    )
}

/** The owner ends one: that token's next use there asks them again. */
export async function endSecretAllowance(
  ctx: VaultContext,
  target: { tokenId: string; secretId: string; origin: string },
): Promise<void> {
  await requireToken(ctx, target.tokenId)
  await requireTypable(ctx, target.secretId)
  await db().apiTokenSecretAllowance.deleteMany({ where: target })
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
  }: { tokenId: string; serverId: string; name: string; use: SecretUseContext },
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

  if (
    await takeSecretUse(
      { tokenId, secretId: secret.id, origin: use.origin },
      now,
    )
  ) {
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
  args: { name: string; purpose: string; origins: string[]; kind?: string },
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

  const existing = await db().secret.findUnique({
    where: { vaultId_name: { vaultId: ctx.vaultId, name } },
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
    kind: args.kind === "totp" ? "totp" : "text",
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
  { value, origins }: { value?: string; origins?: string[] },
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

  const other = await db().secret.findUnique({
    where: { vaultId_name: { vaultId: ctx.vaultId, name: ask.name } },
    select: { id: true },
  })

  if (other) {
    return `A secret called "${ask.name}" exists now that the browser does not type, so this one cannot be saved by that name.`
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
  }: { value?: string; origins?: string[]; level: SecretUseLevel },
): Promise<string> {
  const origins = parseOrigins(chosen ?? ask.origins)

  if (origins.length === 0) {
    throw invalid("Leave at least one site where the secret is typed.")
  }

  let secret = await findTypableSecret(ctx, ask.name)

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
    })
    secret = { id, name: ask.name, kind: ask.kind }
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

  return `The owner saved the secret "${secret.name}"${secret.kind === "totp" ? " (one-time codes: the code of the moment is typed)" : ""} for ${where}. Type it with type's text {"$secret": "${secret.name}"} into a field on a page there; you never see its value. ${uses}`
}
