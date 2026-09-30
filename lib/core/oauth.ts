import { auth } from "@modelcontextprotocol/client"

import type { VaultContext } from "./context"
import { randomSecret } from "./crypto"
import { db } from "./db"
import { PcpError } from "./errors"
import { getServer } from "./servers"
import {
  forgetOAuthTokens,
  oauthCallbackUrl,
  PcpOAuthProvider,
  syncServerTools,
} from "./upstream"

/**
 * Connecting an OAuth-protected MCP server: the SDK runs discovery,
 * registers PCP as a client when the server allows it, and builds the
 * authorization URL; the browser goes there and comes back to the callback
 * route with a code, which is exchanged for tokens.
 */

export type StartResult = { redirectTo: string } | { connected: true }

export async function startOAuth(
  ctx: VaultContext,
  serverId: string,
  { publicUrl }: { publicUrl: string },
): Promise<StartResult> {
  const server = await getServer(ctx, serverId)

  if (server.authType !== "oauth") {
    throw new PcpError("state", `${server.name} does not use OAuth.`)
  }

  const stateId = randomSecret(24)
  const provider = new PcpOAuthProvider(ctx, server, {
    redirectUrl: oauthCallbackUrl(publicUrl, server.id),
    publicUrl,
    stateId,
  })

  const result = await auth(provider, {
    serverUrl: server.url,
    scope: server.oauthScope ?? undefined,
  })

  if (result === "REDIRECT") {
    if (!provider.authorizationUrl) {
      throw new PcpError("upstream", "The server did not say where to sign in.")
    }

    return { redirectTo: provider.authorizationUrl.toString() }
  }

  await syncServerTools(ctx, server, { publicUrl })

  return { connected: true }
}

/** Handles the authorization server's redirect back to PCP. */
export async function finishOAuth(
  ctx: VaultContext,
  serverId: string,
  params: URLSearchParams,
  { publicUrl }: { publicUrl: string },
): Promise<void> {
  const server = await getServer(ctx, serverId)
  const stateId = params.get("state") ?? ""
  const state = stateId
    ? await db().oAuthState.findUnique({ where: { id: stateId } })
    : null

  if (!state || state.serverId !== server.id) {
    throw new PcpError(
      "state",
      "This sign-in link is not one PCP started. Try connecting again.",
    )
  }

  if (state.expiresAt.getTime() < Date.now()) {
    await db().oAuthState.delete({ where: { id: stateId } })
    throw new PcpError(
      "state",
      "This sign-in took too long. Try connecting again.",
    )
  }

  const error = params.get("error")

  if (error) {
    await db().oAuthState.delete({ where: { id: stateId } })
    const description = params.get("error_description") ?? ""
    throw new PcpError(
      "upstream",
      `${server.name} refused the connection (${error}${description ? `: ${description.slice(0, 200)}` : ""}).`,
    )
  }

  const code = params.get("code")

  if (!code) {
    throw new PcpError("state", "The sign-in came back without a code.")
  }

  const provider = new PcpOAuthProvider(ctx, server, {
    redirectUrl: state.redirectUri,
    publicUrl,
    stateId,
  })
  const discovery = await provider.discoveryState()
  const recordedIssuer =
    discovery?.authorizationServerMetadata?.issuer ??
    discovery?.authorizationServerUrl

  try {
    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: code,
      iss: reconcileIssuer(params.get("iss") ?? undefined, recordedIssuer),
      scope: server.oauthScope ?? undefined,
    })

    if (result !== "AUTHORIZED") {
      throw new PcpError("upstream", "The sign-in did not complete.")
    }
  } finally {
    await db().oAuthState.deleteMany({ where: { id: stateId } })
  }

  const fresh = await getServer(ctx, serverId)
  await syncServerTools(ctx, fresh, { publicUrl })
}

const LOOPBACK_HOSTS = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.test(hostname)
}

/**
 * The `iss` a callback carries, reconciled with the issuer discovery
 * recorded. Next.js rewrites the first loopback address in a request URL to
 * "localhost" — and when the server listens on 0.0.0.0 (the Docker image)
 * that first address is the encoded `iss` value itself, so an authorization
 * server on 127.0.0.1 comes back as localhost and fails RFC 9207's check.
 *
 * Only two loopback spellings of the same origin and path are treated as
 * the same issuer. Anything else goes to the SDK unchanged, so a real
 * mix-up (another host, port or path) is still refused.
 */
export function reconcileIssuer(
  received: string | undefined,
  recorded: string | undefined,
): string | undefined {
  if (!received || !recorded || received === recorded) {
    return received
  }

  let a: URL
  let b: URL

  try {
    a = new URL(received)
    b = new URL(recorded)
  } catch {
    return received
  }

  const sameApartFromHost =
    a.protocol === b.protocol &&
    a.port === b.port &&
    a.pathname === b.pathname &&
    a.search === b.search

  return sameApartFromHost && isLoopback(a.hostname) && isLoopback(b.hostname)
    ? recorded
    : received
}

export async function disconnectOAuth(
  ctx: VaultContext,
  serverId: string,
): Promise<void> {
  const server = await getServer(ctx, serverId)
  await forgetOAuthTokens(ctx, server)
}

export async function pruneOAuthStates(): Promise<void> {
  await db().oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } })
}
