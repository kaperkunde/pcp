import {
  auth,
  discoverOAuthServerInfo,
  RegistrationRejectedError,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client"

import type { VaultContext } from "./context"
import { randomSecret } from "./crypto"
import { db } from "./db"
import { PcpError } from "./errors"
import {
  chooseRegistration,
  clientMetadataUrl,
  legacyRedirectUrl,
  oauthRedirectUrl,
} from "./oauth-client"
import { getServer, setServerStatus } from "./servers"
import { syncEndpointTools } from "./endpoints"
import {
  endpointDiscovery,
  forgetOAuthTokens,
  oauthFetch,
  PcpOAuthProvider,
  syncServerTools,
  verifiedEndpointDiscovery,
} from "./upstream"

/**
 * Connecting an OAuth-protected MCP server: PCP discovers the authorization
 * server and decides how to identify itself to it (lib/core/oauth-client.ts);
 * the SDK then registers PCP when that is the way, and builds the
 * authorization URL. The browser goes there and comes back to the callback
 * route with a code, which is exchanged for tokens.
 *
 * A server that does not let PCP register itself waits for the owner
 * (status client_required): they create a client with the provider, using
 * PCP's redirect address, and give PCP its ID and secret.
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
  const probe = new PcpOAuthProvider(ctx, server, {
    redirectUrl: oauthRedirectUrl(publicUrl),
    publicUrl,
  })
  const storedClient = await probe.storedClient()
  const fixed = endpointDiscovery(server)

  if (server.kind === "openapi" && !fixed) {
    throw new PcpError(
      "state",
      `${server.name} has no OAuth sign-in from its schema. Save its settings to read it again.`,
    )
  }

  // An endpoint's sign-in is the one stored from its schema, which its
  // authorization server may add to (where PCP registers itself) but never
  // change; an MCP server's is discovered. The owner's client makes either
  // unnecessary.
  let discovery: OAuthDiscoveryState | undefined
  let elsewhere: { authorization: string; token: string } | null = null

  if (fixed) {
    ;({ discovery, elsewhere } = server.oauthClientId
      ? { discovery: fixed, elsewhere: null }
      : await verifiedEndpointDiscovery(server, fixed))
  } else if (!server.oauthClientId) {
    discovery = await discover(server)
  }

  const method = chooseRegistration({
    clientId: server.oauthClientId,
    storedClient: storedClient !== undefined,
    metadata: discovery?.authorizationServerMetadata,
    metadataUrl: clientMetadataUrl(publicUrl),
  })

  if (method === "needs-client") {
    throw await needsClient(
      server,
      publicUrl,
      elsewhere
        ? `it publishes its sign-in at ${elsewhere.authorization} and its tokens at ${elsewhere.token}, not the addresses this endpoint was approved with, and PCP signs in only where you approved`
        : undefined,
    )
  }

  const provider = new PcpOAuthProvider(ctx, server, {
    redirectUrl: redirectFor(storedClient, publicUrl, server.id),
    publicUrl,
    stateId,
    ...(method === "metadata-document"
      ? { clientMetadataUrl: clientMetadataUrl(publicUrl)! }
      : {}),
  })

  if (discovery) {
    // The flow uses what was just discovered rather than asking again.
    await provider.saveDiscoveryState(discovery)
  }

  let result: Awaited<ReturnType<typeof auth>>

  try {
    result = await auth(provider, {
      serverUrl: server.url,
      scope: server.oauthScope ?? undefined,
      fetchFn: oauthFetch(server),
    })
  } catch (error) {
    // A registration endpoint that refuses PCP (an allow-list of clients,
    // or a guessed /register that is not there) leaves the same way out.
    if (error instanceof RegistrationRejectedError) {
      throw await needsClient(server, publicUrl, rejection(error))
    }

    throw error
  }

  if (result === "REDIRECT") {
    if (!provider.authorizationUrl) {
      throw new PcpError("upstream", "The server did not say where to sign in.")
    }

    return { redirectTo: provider.authorizationUrl.toString() }
  }

  await afterConnecting(ctx, server, publicUrl)

  return { connected: true }
}

async function discover(server: {
  url: string
}): Promise<OAuthDiscoveryState | undefined> {
  try {
    const info = await discoverOAuthServerInfo(server.url)

    return {
      authorizationServerUrl: String(info.authorizationServerUrl),
      resourceMetadata: info.resourceMetadata,
      authorizationServerMetadata: info.authorizationServerMetadata,
    }
  } catch {
    // The SDK's own discovery runs next and reports what is wrong.
    return undefined
  }
}

/**
 * The redirect address for this flow. A client PCP registered before there
 * was one address for the whole install only knows the per-server one; the
 * server would refuse any other.
 */
function redirectFor(
  storedClient: object | undefined,
  publicUrl: string,
  serverId: string,
): string {
  const current = oauthRedirectUrl(publicUrl)
  const legacy = legacyRedirectUrl(publicUrl, serverId)
  const listed = (storedClient as { redirect_uris?: unknown } | undefined)
    ?.redirect_uris
  const registered = Array.isArray(listed) ? listed : []

  return registered.includes(legacy) && !registered.includes(current)
    ? legacy
    : current
}

function rejection(error: RegistrationRejectedError): string {
  try {
    const body = JSON.parse(error.body) as {
      error?: string
      error_description?: string
    }
    const said = [body.error, body.error_description].filter(Boolean).join(": ")

    if (said) {
      return `it refused PCP's registration (${said.slice(0, 200)})`
    }
  } catch {
    // Not JSON: say only the status.
  }

  return `it refused PCP's registration (HTTP ${error.status})`
}

/**
 * Records that the server waits for the owner's client and says what to do.
 * The message is the server page's status line and what an assistant hears.
 */
async function needsClient(
  server: { id: string; name: string },
  publicUrl: string,
  why = "it does not let apps register themselves",
): Promise<PcpError> {
  const message = `${server.name} needs an OAuth client from you: ${why}. Create one in the provider's developer settings with ${oauthRedirectUrl(publicUrl)} as its redirect URI, then give PCP its client ID and secret on the server's page.`

  await setServerStatus(server.id, "client_required", message)

  return new PcpError("state", message)
}

/**
 * Handles the authorization server's redirect back to PCP. The state
 * parameter names the flow, and the flow names the server; `serverId` is
 * given by the per-server callback address older registrations use.
 */
export async function finishOAuth(
  ctx: VaultContext,
  params: URLSearchParams,
  { publicUrl, serverId }: { publicUrl: string; serverId?: string },
): Promise<{ serverId: string }> {
  const stateId = params.get("state") ?? ""
  const state = stateId
    ? await db().oAuthState.findUnique({ where: { id: stateId } })
    : null

  if (!state || (serverId !== undefined && state.serverId !== serverId)) {
    throw new PcpError(
      "state",
      "This sign-in link is not one PCP started. Try connecting again.",
    )
  }

  // Another vault's flow reads as not found, like any other server of theirs.
  const server = await getServer(ctx, state.serverId)

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
      fetchFn: oauthFetch(server),
    })

    if (result !== "AUTHORIZED") {
      throw new PcpError("upstream", "The sign-in did not complete.")
    }
  } finally {
    await db().oAuthState.deleteMany({ where: { id: stateId } })
  }

  await afterConnecting(ctx, await getServer(ctx, server.id), publicUrl)

  return { serverId: server.id }
}

/**
 * A server just connected: an MCP server's tools are read now that PCP may.
 * An endpoint's tools come from its schema, not the sign-in, so they are
 * rebuilt from the copy PCP holds, which also sets its status.
 */
async function afterConnecting(
  ctx: VaultContext,
  server: Awaited<ReturnType<typeof getServer>>,
  publicUrl: string,
): Promise<void> {
  if (server.kind === "openapi") {
    await syncEndpointTools(server, { fromCopy: true })
    return
  }

  await syncServerTools(ctx, server, { publicUrl })
}

/** Where the callback sends the owner's browser when it cannot finish. */
export async function serverForState(
  ctx: VaultContext,
  params: URLSearchParams,
): Promise<string | null> {
  const stateId = params.get("state")
  const state = stateId
    ? await db().oAuthState.findUnique({
        where: { id: stateId },
        select: { serverId: true, server: { select: { vaultId: true } } },
      })
    : null

  return state && state.server.vaultId === ctx.vaultId ? state.serverId : null
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

export async function pruneOAuthStates(): Promise<number> {
  const { count } = await db().oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })

  return count
}
