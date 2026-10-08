import { createHash } from "node:crypto"

import {
  endOAuthSignIns,
  liveToken,
  revokeOAuthApiToken,
  type ResolvedToken,
} from "../api-tokens"
import type { VaultContext } from "../context"
import { randomSecret, safeEqual, sha256Hex } from "../crypto"
import { db } from "../db"
import { newId } from "../ids"
import { credentialGrantData, unlockWithCredential } from "../keys"
import { authenticateClient, type ClientCredentials } from "./clients"
import {
  invalidClient,
  invalidGrant,
  invalidRequest,
  OAuthError,
} from "./errors"
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CODE_TTL_MS,
  MAX_PARAM_LENGTH,
  REFRESH_TOKEN_TTL_MS,
} from "./limits"
import { isOwnResource } from "./metadata"

/**
 * What PCP's authorization server issues, and the token endpoint that
 * trades one for another.
 *
 * Each code, access token and refresh token is a random value that wraps
 * the vault's data key in a grant of its own, exactly like an API token:
 * the database keeps the SHA-256 for lookup and the key wrapped under a KEK
 * derived from the value, so it is no more readable than before without a
 * credential an assistant holds. The chain starts with the owner: approving
 * a sign-in wraps the key under the new code, with the key their session
 * unwrapped.
 *
 * A code and a refresh token work once. Spent, they keep their row (and
 * lose their grant) until they would have expired, so a second use is
 * seen: it ends every sign-in of that token, as OAuth 2.1 advises for a
 * credential that may have been stolen.
 */

export const CODE_PREFIX = "pcp_code_"
export const ACCESS_TOKEN_PREFIX = "pcp_at_"
export const REFRESH_TOKEN_PREFIX = "pcp_rt_"

type CredentialKind = "code" | "access" | "refresh"

const KINDS = {
  code: { prefix: CODE_PREFIX, grant: "oauth_code" },
  access: { prefix: ACCESS_TOKEN_PREFIX, grant: "oauth_access" },
  refresh: { prefix: REFRESH_TOKEN_PREFIX, grant: "oauth_refresh" },
} as const

export type TokenResponse = {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  refresh_token: string
  scope?: string
}

type CredentialInput = {
  tokenId: string
  clientId: string
  redirectUri?: string
  codeChallenge?: string
  resource?: string | null
  scope?: string | null
}

/** A new credential's value, and the rows that hold it. */
async function prepareCredential(
  ctx: VaultContext,
  kind: CredentialKind,
  ttlMs: number,
  input: CredentialInput,
) {
  const value = `${KINDS[kind].prefix}${randomSecret()}`
  const grant = await credentialGrantData(
    ctx.vaultId,
    ctx.dek,
    KINDS[kind].grant,
    value,
  )

  return {
    value,
    grant,
    credential: {
      id: newId(),
      vaultId: ctx.vaultId,
      tokenId: input.tokenId,
      grantId: grant.id,
      kind,
      lookupHash: sha256Hex(value),
      clientId: input.clientId,
      redirectUri: input.redirectUri ?? null,
      codeChallenge: input.codeChallenge ?? null,
      resource: input.resource ?? null,
      scope: input.scope ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  }
}

/**
 * The code for a sign-in the owner just approved, with the key their
 * session holds. Lives two minutes and works once.
 */
export async function issueCode(
  ctx: VaultContext,
  input: CredentialInput & { redirectUri: string; codeChallenge: string },
): Promise<string> {
  const code = await prepareCredential(ctx, "code", CODE_TTL_MS, input)

  await db().$transaction([
    db().keyGrant.create({ data: code.grant }),
    db().oAuthCredential.create({ data: code.credential }),
  ])
  pruneSoon()

  return code.value
}

type SpendableRow = { id: string; grantId: string | null }

/** Takes a credential's grant away; its row stays to catch a second use. */
function spend(row: SpendableRow) {
  return [
    db().oAuthCredential.update({
      where: { id: row.id },
      data: { grantId: null, usedAt: new Date() },
    }),
    db().keyGrant.deleteMany({ where: { id: row.grantId ?? "" } }),
  ] as const
}

/**
 * Marks a credential used, if nobody did first: two requests with the same
 * code (or refresh token) cannot both get tokens.
 */
async function claim(id: string): Promise<boolean> {
  const result = await db().oAuthCredential.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date() },
  })

  return result.count === 1
}

/** A second use of a spent code or refresh token ends the token's sign-ins. */
async function replayed(tokenId: string): Promise<never> {
  await db().$transaction([...endOAuthSignIns([tokenId])])
  throw invalidGrant(
    "This credential was used before, so every sign-in it belongs to has ended. Sign in again.",
  )
}

/**
 * Issues an access token and a refresh token for a token, in the same
 * transaction that spends the credential they replace.
 */
async function issuePair(
  ctx: VaultContext,
  spent: SpendableRow,
  input: CredentialInput,
): Promise<TokenResponse> {
  const access = await prepareCredential(
    ctx,
    "access",
    ACCESS_TOKEN_TTL_SECONDS * 1000,
    input,
  )
  const refresh = await prepareCredential(
    ctx,
    "refresh",
    REFRESH_TOKEN_TTL_MS,
    input,
  )

  await db().$transaction([
    ...spend(spent),
    db().keyGrant.create({ data: access.grant }),
    db().keyGrant.create({ data: refresh.grant }),
    db().oAuthCredential.create({ data: access.credential }),
    db().oAuthCredential.create({ data: refresh.credential }),
  ])
  pruneSoon()

  return {
    access_token: access.value,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.value,
    ...(input.scope ? { scope: input.scope } : {}),
  }
}

/** The vault key a live credential's grant unwraps, or null. */
async function unlock(
  kind: CredentialKind,
  value: string,
  row: SpendableRow,
): Promise<Buffer | null> {
  const unlocked = await unlockWithCredential(KINDS[kind].grant, value)

  return unlocked && unlocked.grant.id === row.grantId ? unlocked.dek : null
}

/** Whether the token a credential is for may still be used. */
async function tokenIsLive(tokenId: string): Promise<boolean> {
  const token = await db().apiToken.findUnique({ where: { id: tokenId } })

  return Boolean(
    token &&
    !token.revokedAt &&
    (!token.expiresAt || token.expiresAt.getTime() > Date.now()),
  )
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

/** grant_type=authorization_code (RFC 6749 §4.1.3, with PKCE). */
export async function exchangeCode(
  params: Record<string, string>,
  clientId: string,
  publicUrl: string,
): Promise<TokenResponse> {
  const code = params.code ?? ""

  if (!code) {
    throw invalidRequest("Send the code.")
  }

  const row = await db().oAuthCredential.findUnique({
    where: { lookupHash: sha256Hex(code) },
  })

  if (!row || row.kind !== "code") {
    throw invalidGrant("PCP does not know this code.")
  }

  if (row.usedAt) {
    return replayed(row.tokenId)
  }

  // Any mismatch spends the code: it gets one try, so a stolen one cannot
  // be tried against verifiers.
  const refuse = async (description: string): Promise<never> => {
    if (await claim(row.id)) {
      await db().$transaction([...spend(row)])
    }
    throw invalidGrant(description)
  }

  if (row.clientId !== clientId) {
    return refuse("This code was issued to another client.")
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return refuse("This code has expired. Sign in again.")
  }

  if (params.redirect_uri !== row.redirectUri) {
    return refuse(
      "redirect_uri is not the one the code was issued for, or is missing.",
    )
  }

  if (params.resource && !isOwnResource(params.resource, publicUrl)) {
    return refuse("The resource is not this PCP's /mcp.")
  }

  const verifier = params.code_verifier ?? ""

  if (
    !VERIFIER.test(verifier) ||
    !row.codeChallenge ||
    !safeEqual(s256(verifier), row.codeChallenge)
  ) {
    return refuse("The code_verifier does not match the code_challenge.")
  }

  if (!(await claim(row.id))) {
    return replayed(row.tokenId)
  }

  const dek = await unlock("code", code, row)

  if (!dek || !(await tokenIsLive(row.tokenId))) {
    await db().$transaction([...spend(row)])
    throw invalidGrant("This sign-in was revoked. Sign in again.")
  }

  return issuePair({ vaultId: row.vaultId, dek }, row, {
    tokenId: row.tokenId,
    clientId,
    resource: row.resource,
    scope: row.scope,
  })
}

/** grant_type=refresh_token: a new pair, the old refresh token spent. */
export async function refreshTokens(
  params: Record<string, string>,
  clientId: string,
  publicUrl: string,
): Promise<TokenResponse> {
  const value = params.refresh_token ?? ""

  if (!value) {
    throw invalidRequest("Send the refresh_token.")
  }

  const row = await db().oAuthCredential.findUnique({
    where: { lookupHash: sha256Hex(value) },
  })

  if (!row || row.kind !== "refresh") {
    throw invalidGrant("PCP does not know this refresh token.")
  }

  if (row.usedAt) {
    return replayed(row.tokenId)
  }

  if (row.clientId !== clientId) {
    throw invalidGrant("This refresh token was issued to another client.")
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    throw invalidGrant("This refresh token has expired. Sign in again.")
  }

  if (params.resource && !isOwnResource(params.resource, publicUrl)) {
    throw new OAuthError(
      "invalid_target",
      "The resource is not this PCP's /mcp.",
    )
  }

  if (!(await claim(row.id))) {
    return replayed(row.tokenId)
  }

  const dek = await unlock("refresh", value, row)

  if (!dek || !(await tokenIsLive(row.tokenId))) {
    await db().$transaction([...spend(row)])
    throw invalidGrant("This sign-in was revoked. Sign in again.")
  }

  return issuePair({ vaultId: row.vaultId, dek }, row, {
    tokenId: row.tokenId,
    clientId,
    resource: row.resource,
    scope: row.scope,
  })
}

/**
 * How the client authenticated: HTTP Basic (client_secret_basic), a secret
 * in the form (client_secret_post), or neither (a public client naming
 * itself with client_id). Values in a Basic header are form-encoded
 * (RFC 6749 §2.3.1).
 */
export function clientCredentialsFrom(
  authorization: string | null,
  params: Record<string, string>,
): ClientCredentials {
  const basic = authorization?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i)

  if (basic) {
    if (params.client_secret) {
      throw invalidRequest("Authenticate the client one way, not two.")
    }

    const decoded = Buffer.from(basic[1], "base64").toString("utf8")
    const colon = decoded.indexOf(":")

    if (colon < 0) {
      throw invalidClient("The Basic credentials are malformed.")
    }

    let id: string
    let secret: string

    try {
      id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "))
      secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " "))
    } catch {
      throw invalidClient("The Basic credentials are malformed.")
    }

    if (params.client_id !== undefined && params.client_id !== id) {
      throw invalidClient("client_id differs from the Basic credentials.")
    }

    return { clientId: id, secret, method: "client_secret_basic" }
  }

  if (authorization) {
    throw invalidClient("PCP takes client credentials as HTTP Basic only.")
  }

  // Some public clients send an empty client_secret: that is none.
  const secret = params.client_secret || null

  return {
    clientId: params.client_id || null,
    secret,
    method: secret === null ? "none" : "client_secret_post",
  }
}

/** The token endpoint: authenticates the client, then the grant. */
export async function tokenRequest(
  params: Record<string, string>,
  authorization: string | null,
  publicUrl: string,
): Promise<TokenResponse> {
  for (const value of Object.values(params)) {
    if (value.length > MAX_PARAM_LENGTH) {
      throw invalidRequest("A parameter is too long.")
    }
  }

  const clientId = await authenticateClient(
    clientCredentialsFrom(authorization, params),
  )

  switch (params.grant_type) {
    case "authorization_code":
      return exchangeCode(params, clientId, publicUrl)
    case "refresh_token":
      return refreshTokens(params, clientId, publicUrl)
    case undefined:
    case "":
      throw invalidRequest("Send a grant_type.")
    default:
      throw new OAuthError(
        "unsupported_grant_type",
        "PCP issues tokens for authorization_code and refresh_token only.",
      )
  }
}

/**
 * Token revocation (RFC 7009). An unknown token, or one issued to another
 * client, is answered the same as a revoked one. A refresh token stands for
 * the sign-in: revoking it revokes the token it was issued for, as the
 * owner's Revoke would. An access token is just deleted.
 */
export async function revokeRequest(
  params: Record<string, string>,
  authorization: string | null,
): Promise<void> {
  const clientId = await authenticateClient(
    clientCredentialsFrom(authorization, params),
  )
  const value = params.token ?? ""

  if (!value) {
    throw invalidRequest("Send the token to revoke.")
  }

  if (value.length > MAX_PARAM_LENGTH) {
    return
  }

  const row = await db().oAuthCredential.findUnique({
    where: { lookupHash: sha256Hex(value) },
  })

  if (!row || row.clientId !== clientId) {
    return
  }

  if (row.kind === "refresh") {
    await revokeOAuthApiToken(row.tokenId)
    return
  }

  // The row goes with its grant (or alone, if it was spent already).
  await db().$transaction([
    db().keyGrant.deleteMany({ where: { id: row.grantId ?? "" } }),
    db().oAuthCredential.deleteMany({ where: { id: row.id } }),
  ])
}

/**
 * The token behind an access token presented to /mcp, with the key its
 * grant unwraps: null when it is unknown, expired, or its token is
 * revoked or expired.
 */
export async function resolveAccessToken(
  value: string,
): Promise<ResolvedToken | null> {
  if (!value.startsWith(ACCESS_TOKEN_PREFIX)) {
    return null
  }

  const row = await db().oAuthCredential.findUnique({
    where: { lookupHash: sha256Hex(value) },
  })

  if (
    !row ||
    row.kind !== "access" ||
    !row.grantId ||
    row.expiresAt.getTime() <= Date.now()
  ) {
    return null
  }

  const dek = await unlock("access", value, row)

  return dek ? liveToken({ id: row.tokenId }, dek) : null
}

/**
 * Deletes credentials past their expiry, with their grants (a spent code or
 * refresh token, kept to catch a second use, goes once it would have
 * expired too). The scheduled cleanup runs it, and issuing does at most
 * once a minute. Returns how many went.
 */
export async function pruneOAuthCredentials(now = new Date()): Promise<number> {
  const expired = { expiresAt: { lte: now } }
  const [count] = await db().$transaction([
    db().oAuthCredential.count({ where: expired }),
    db().keyGrant.deleteMany({ where: { oauthCredential: { is: expired } } }),
    // The spent ones, which have no grant to take them along.
    db().oAuthCredential.deleteMany({ where: expired }),
  ])

  return count
}

const PRUNE_INTERVAL_MS = 60_000
let lastPruned = 0

function pruneSoon(): void {
  if (Date.now() - lastPruned < PRUNE_INTERVAL_MS) {
    return
  }

  lastPruned = Date.now()
  void pruneOAuthCredentials().catch(() => {})
}
