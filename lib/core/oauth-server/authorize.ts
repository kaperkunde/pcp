import {
  createOAuthApiToken,
  deleteApiToken,
  endOAuthSignIns,
  requireLiveToken,
  type TokenInput,
} from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { PcpError } from "../errors"
import {
  findClient,
  markClientUsed,
  type DocumentFetcher,
  type OAuthClientInfo,
} from "./clients"
import { OAuthError } from "./errors"
import { MAX_PARAM_LENGTH } from "./limits"
import { isOwnResource, oauthUrls } from "./metadata"
import { issueCode } from "./tokens"

/**
 * The authorization endpoint's logic (RFC 6749 §4.1.1, OAuth 2.1): what a
 * sign-in request asks for, and what approving or refusing it sends back.
 * The page (app/oauth/authorize/) shows it to the signed-in owner, who
 * confirms with their password or Touch ID before anything is made.
 *
 * Until the client and its redirect URI check out, nothing goes back to the
 * client: the owner is shown what is wrong instead, so PCP never sends
 * anyone to an address the client did not register. Past that, an error
 * goes back on its own only to an app the owner let in before
 * (`errorGoesBack`).
 */

export type AuthorizationRequest = {
  client: OAuthClientInfo
  redirectUri: string
  codeChallenge: string
  state: string | null
  scope: string | null
  resource: string
}

export type AuthorizationCheck =
  | { kind: "ok"; request: AuthorizationRequest }
  /** Shown to the owner; nothing goes back to the client. */
  | { kind: "show"; message: string }
  /**
   * An error the client is sent back with, at `url`; `description` says
   * what it is, for PCP's page when the owner is not sent there at once.
   */
  | {
      kind: "redirect"
      url: string
      client: OAuthClientInfo
      returnHost: string
      description: string
    }

export type AuthorizationParams = Record<string, string | undefined>

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/

/** The redirect URI with the answer's parameters added to its query. */
function redirectTo(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri)

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, value)
    }
  }

  return url.toString()
}

export async function checkAuthorizationRequest(
  params: AuthorizationParams,
  publicUrl: string,
  fetcher?: DocumentFetcher,
): Promise<AuthorizationCheck> {
  const clientId = params.client_id ?? ""

  if (!clientId) {
    return {
      kind: "show",
      message: "The sign-in does not say which app is asking (no client_id).",
    }
  }

  let client: OAuthClientInfo

  try {
    client = await findClient(clientId, fetcher)
  } catch (error) {
    if (error instanceof OAuthError) {
      return { kind: "show", message: error.message }
    }

    throw error
  }

  let redirectUri = params.redirect_uri

  if (redirectUri === undefined) {
    if (client.redirectUris.length !== 1) {
      return {
        kind: "show",
        message: `${client.name} did not say where to send you back to (no redirect_uri).`,
      }
    }

    redirectUri = client.redirectUris[0]
  } else if (!client.redirectUris.includes(redirectUri)) {
    return {
      kind: "show",
      message: `${client.name} asked to send you back to ${redirectUri}, which is not an address it registered. PCP sends nothing there.`,
    }
  }

  const state = params.state ?? null
  const issuer = oauthUrls(publicUrl).issuer
  const refuse = (error: string, description: string): AuthorizationCheck => ({
    kind: "redirect",
    url: redirectTo(redirectUri, {
      error,
      error_description: description,
      state: state && state.length <= MAX_PARAM_LENGTH ? state : null,
      iss: issuer,
    }),
    client,
    returnHost: returnHostOf(redirectUri),
    description,
  })

  if (params.response_type !== "code") {
    return refuse(
      "unsupported_response_type",
      "PCP supports response_type=code only.",
    )
  }

  for (const name of ["state", "scope", "code_challenge", "resource"]) {
    if ((params[name]?.length ?? 0) > MAX_PARAM_LENGTH) {
      return refuse("invalid_request", `${name} is too long.`)
    }
  }

  const challenge = params.code_challenge ?? ""

  if (!challenge || params.code_challenge_method !== "S256") {
    return refuse(
      "invalid_request",
      "PKCE is required: send a code_challenge with code_challenge_method=S256.",
    )
  }

  if (!CHALLENGE.test(challenge)) {
    return refuse(
      "invalid_request",
      "code_challenge must be the base64url SHA-256 of the verifier.",
    )
  }

  const resource = params.resource ?? oauthUrls(publicUrl).resource

  if (!isOwnResource(resource, publicUrl)) {
    return refuse(
      "invalid_target",
      `PCP issues tokens for ${oauthUrls(publicUrl).resource} only.`,
    )
  }

  return {
    kind: "ok",
    request: {
      client,
      redirectUri,
      codeChallenge: challenge,
      state,
      scope: params.scope?.trim() || null,
      resource: oauthUrls(publicUrl).resource,
    },
  }
}

/** Where the owner is sent back to, as the consent page shows it. */
function returnHostOf(redirectUri: string): string {
  return new URL(redirectUri).host || redirectUri
}

const SEEN_NAME = "pcp_seen_name"
const SEEN_HOST = "pcp_seen_host"
const SEEN_RETURN = "pcp_seen_return"

/**
 * The query the consent page carries back with the owner's answer: the
 * request with the return address it resolved written in (a client that
 * sent none had its document's one address filled in, and a document read
 * again later must not choose a different one), and the app and return host
 * the owner was shown. The three marks are the page's own; any a client
 * sent are replaced.
 */
export function consentQuery(
  params: AuthorizationParams,
  request: AuthorizationRequest,
): string {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, value)
    }
  }

  query.set("redirect_uri", request.redirectUri)
  query.set(SEEN_NAME, request.client.name)
  query.set(SEEN_HOST, request.client.host)
  query.set(SEEN_RETURN, returnHostOf(request.redirectUri))

  return query.toString()
}

/**
 * The consent page's query checked again at the answer: the client's
 * document is read afresh, and the answer stands only if it still names the
 * app and return host the owner saw. The page may have been open for a
 * while, and a document is the client's to change.
 */
export async function recheckAuthorization(
  query: string,
  publicUrl: string,
  fetcher?: DocumentFetcher,
): Promise<AuthorizationCheck> {
  const params: AuthorizationParams = Object.fromEntries(
    new URLSearchParams(query),
  )
  const seen = [SEEN_NAME, SEEN_HOST, SEEN_RETURN].map((key) => params[key])

  for (const key of [SEEN_NAME, SEEN_HOST, SEEN_RETURN]) {
    delete params[key]
  }

  const check = await checkAuthorizationRequest(params, publicUrl, fetcher)

  if (check.kind !== "ok") {
    return check
  }

  const { client, redirectUri } = check.request
  const now = [client.name, client.host, returnHostOf(redirectUri)]

  if (now.some((value, index) => value !== seen[index])) {
    return {
      kind: "show",
      message: `What ${client.name} says about itself changed since you were shown this sign-in. Start connecting it again from the app.`,
    }
  }

  return check
}

/** Where the owner's choice goes: a new token, or one this client had. */
export type AuthorizationChoice = { tokenId: string } | { token: TokenInput }

/**
 * The owner approved: a new API token for the assistant (or the one it had
 * before, which keeps its levels and memories and loses its earlier
 * sign-ins), and a code that carries the vault key to the token endpoint.
 * Returns where to send the owner: the client's redirect URI with the code.
 * The caller has confirmed the owner (confirmOwner).
 */
export async function approveAuthorization(
  ctx: VaultContext,
  request: AuthorizationRequest,
  choice: AuthorizationChoice,
  publicUrl: string,
): Promise<{ tokenId: string; redirect: string }> {
  let tokenId: string
  let made = false

  if ("tokenId" in choice) {
    const token = await requireLiveToken(ctx, choice.tokenId)

    if (token.oauthClientId !== request.client.id) {
      throw new PcpError(
        "forbidden",
        "That token was made for another app; pick a new one instead.",
      )
    }

    tokenId = token.id
    await db().$transaction([
      ...endOAuthSignIns([tokenId]),
      db().apiToken.update({
        where: { id: tokenId },
        data: { oauthClientName: request.client.name },
      }),
    ])
  } else {
    ;({ id: tokenId } = await createOAuthApiToken(ctx, {
      ...choice.token,
      clientId: request.client.id,
      clientName: request.client.name,
    }))
    made = true
  }

  let code: string

  try {
    code = await issueCode(ctx, {
      tokenId,
      clientId: request.client.id,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      scope: request.scope,
    })
  } catch (error) {
    if (made) {
      await deleteApiToken(ctx, tokenId).catch(() => {})
    }

    throw error
  }

  await markClientUsed(request.client.id)

  return {
    tokenId,
    redirect: redirectTo(request.redirectUri, {
      code,
      state: request.state,
      iss: oauthUrls(publicUrl).issuer,
    }),
  }
}

/** The owner said no: the client hears access_denied. */
export function denyAuthorization(
  request: AuthorizationRequest,
  publicUrl: string,
): string {
  return redirectTo(request.redirectUri, {
    error: "access_denied",
    error_description: "The owner did not allow this sign-in.",
    state: request.state,
    iss: oauthUrls(publicUrl).issuer,
  })
}

/**
 * Whether an error in a sign-in sends the owner straight back to the app
 * (RFC 9700 §4.11.2). Anyone can register a client or publish a metadata
 * document naming any return address, so doing that for every app would
 * let a link to PCP bounce the owner anywhere, before they see a thing or
 * right after they sign in. Only an app the owner let in before, and whose
 * token from that is still live, gets its error at once; for any other the
 * page shows it, with a link back the owner can choose to follow.
 */
export async function errorGoesBack(
  ctx: VaultContext,
  clientId: string,
): Promise<boolean> {
  return (await tokensForClient(ctx, clientId)).length > 0
}

/** Live tokens this client was given before, to sign in to again. */
export async function tokensForClient(
  ctx: VaultContext,
  clientId: string,
): Promise<Array<{ id: string; name: string; createdAt: Date }>> {
  return db().apiToken.findMany({
    where: {
      vaultId: ctx.vaultId,
      oauthClientId: clientId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  })
}
