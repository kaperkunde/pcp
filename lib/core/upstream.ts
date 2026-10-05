import {
  auth,
  Client,
  discoverAuthorizationServerMetadata,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type FetchLike,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client"

import type { McpServer } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "./catalogue"
import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import { callEndpointTool, syncEndpointTools } from "./endpoints"
import { isPcpError, PcpError } from "./errors"
import { callMailTool, syncMailTools } from "./mail/accounts"
import type { MailCredential } from "./mail/types"
import { send } from "./openapi/transport"
import {
  applyAuthorizeParams,
  applySignInDefaults,
  oauthRedirectUrl,
  registrationMetadata,
  signInDefaults,
  tokenLifetime,
} from "./oauth-client"
import {
  deleteManagedSecret,
  readSecretValue,
  revealSecret,
  writeManagedSecret,
} from "./secrets"
import {
  extraAuthHeaders,
  isMailKind,
  renderAuthValue,
  setServerStatus,
} from "./servers"
import { resolveHandles } from "./result-handles"
import type { BytesKeeper, ResultKeeper, ResultOpener } from "./tool-results"
import { PCP_VERSION } from "./version"

/**
 * Talking to the servers in the registry: opening a connection with the
 * right credentials, reading their tool lists and calling their tools. API
 * endpoints (kind "openapi") branch off to lib/core/endpoints.ts, which
 * makes plain HTTP calls with the header this module builds; mail accounts
 * (kinds "jmap" and "imap") to lib/core/mail/accounts.ts, with the header
 * or login this module builds, or an OAuth token it renews.
 *
 * Credentials are decrypted here, used for the one connection and dropped.
 * Nothing in this module returns a secret to a caller.
 */

export const PCP_CLIENT_INFO = { name: "pcp", version: PCP_VERSION }

const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000

export function managedSecretName(server: Pick<McpServer, "id">): string {
  return `oauth/${server.id}`
}

/**
 * An OAuth server without a live token set: never connected, disconnected,
 * or its refresh failed (the provider clears oauthConnectedAt then).
 */
export function needsConnecting(
  server: Pick<McpServer, "authType" | "oauthConnectedAt">,
): boolean {
  return server.authType === "oauth" && server.oauthConnectedAt === null
}

/** Where the owner's browser starts connecting an OAuth server. */
export function oauthStartUrl(publicUrl: string, serverId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/servers/${serverId}/oauth/start`
}

/** What an authorization in flight needs on the callback leg. */
type FlowState = {
  verifier?: string
  discovery?: OAuthDiscoveryState
}

type OAuthStore = {
  client?: StoredOAuthClientInformation
  /**
   * The authorization server the owner's own client was first used with.
   * The SDK refuses to send the client to any other (SEP-2352), so a server
   * that later points somewhere else never gets the client secret.
   */
  clientIssuer?: { clientId: string; issuer: string }
  tokens?: StoredOAuthTokens
  tokensSavedAt?: string
}

/**
 * The SDK's view of PCP as an OAuth client for one server. Registration and
 * tokens live in a managed secret; the PKCE verifier of an authorization in
 * flight lives in an OAuthState row keyed by the state parameter, so the
 * callback (a different request) can find it.
 */
export class PcpOAuthProvider implements OAuthClientProvider {
  /** Set when the flow needs the person's browser: where to send it. */
  authorizationUrl: URL | null = null

  /**
   * An API endpoint's token is not bound to a resource (RFC 8707): the
   * schema names no resource identifier, and providers that do not know the
   * parameter can refuse it. Left undefined for MCP servers, where the SDK
   * uses the resource their metadata names.
   */
  validateResourceURL?: OAuthClientProvider["validateResourceURL"]

  constructor(
    private readonly ctx: VaultContext,
    private readonly server: McpServer,
    private readonly options: {
      redirectUrl: string
      publicUrl: string
      stateId?: string
      /**
       * PCP's client metadata document, offered as the client ID. Set only
       * when startOAuth chose it (lib/core/oauth-client.ts says when).
       */
      clientMetadataUrl?: string
    },
  ) {
    if (server.kind === "openapi") {
      this.validateResourceURL = async () => undefined
    }
  }

  get redirectUrl(): string {
    return this.options.redirectUrl
  }

  get clientMetadataUrl(): string | undefined {
    return this.options.clientMetadataUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return registrationMetadata({
      publicUrl: this.options.publicUrl,
      redirectUrl: this.options.redirectUrl,
      version: PCP_CLIENT_INFO.version,
      confidential: Boolean(this.server.oauthClientSecretId),
      scope: this.server.oauthScope,
    })
  }

  /**
   * Interactive when started from the owner's browser (a state id names
   * the authorization in flight). A gateway call or a tool refresh has no
   * browser to send anywhere: without tokens it stops as "needs
   * connecting" rather than starting a flow nobody can finish.
   */
  private get interactive(): boolean {
    return Boolean(this.options.stateId)
  }

  state(): string {
    return this.options.stateId ?? ""
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    if (this.server.oauthClientId) {
      const { clientIssuer } = await this.readStore()

      return {
        client_id: this.server.oauthClientId,
        ...(clientIssuer?.clientId === this.server.oauthClientId
          ? { issuer: clientIssuer.issuer }
          : {}),
        ...(this.server.oauthClientSecretId
          ? {
              client_secret: await readSecretValue(
                this.ctx,
                this.server.oauthClientSecretId,
              ),
            }
          : {}),
      }
    }

    const { client } = await this.readStore()

    // Without the owner's browser nothing can be signed in to, so there is
    // nothing to register for either: say it needs connecting rather than
    // register in the background (or fail to, on a server that does not
    // allow it).
    if (!client && !this.interactive) {
      throw new UnauthorizedError(
        `${this.server.name} needs to be connected in PCP.`,
      )
    }

    return client
  }

  /** The client PCP registered earlier (dynamically or by its document). */
  async storedClient(): Promise<StoredOAuthClientInformation | undefined> {
    return this.server.oauthClientId
      ? undefined
      : (await this.readStore()).client
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
  ): Promise<void> {
    if (this.server.oauthClientId) {
      // Only the stamp of which authorization server it belongs to; the
      // client itself is the owner's settings.
      const { client_id: clientId, issuer } = clientInformation

      if (
        clientId === this.server.oauthClientId &&
        typeof issuer === "string"
      ) {
        await this.updateStore((store) => ({
          ...store,
          clientIssuer: { clientId, issuer },
        }))
      }

      return
    }

    await this.updateStore((store) => ({ ...store, client: clientInformation }))
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.readStore()).tokens
  }

  async tokenSet(): Promise<{
    tokens: StoredOAuthTokens | undefined
    savedAt: string | undefined
    /** The authorization server the client is bound to, when known. */
    issuer: string | undefined
  }> {
    const store = await this.readStore()
    const issuer =
      store.clientIssuer?.issuer ??
      (store.client as { issuer?: unknown } | undefined)?.issuer
    return {
      tokens: store.tokens,
      savedAt: store.tokensSavedAt,
      issuer: typeof issuer === "string" ? issuer : undefined,
    }
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.updateStore((store) => ({
      ...store,
      tokens,
      tokensSavedAt: new Date().toISOString(),
    }))
    await db().mcpServer.update({
      where: { id: this.server.id },
      data: { oauthConnectedAt: new Date() },
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      throw new UnauthorizedError(
        `${this.server.name} needs to be connected in PCP.`,
      )
    }

    this.authorizationUrl = applySignInDefaults(
      applyAuthorizeParams(authorizationUrl, this.server.oauthAuthorizeParams),
    )
  }

  /**
   * Discovery results (which authorization server the flow is bound to)
   * are kept with the PKCE verifier, so the callback leg can check the
   * code came from the server the redirect went to (SEP-2352).
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.pendingDiscovery = state

    if (this.interactive) {
      await this.writeFlowState({ discovery: state })
    }
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const saved = this.interactive
      ? ((await this.readFlowState())?.discovery ?? this.pendingDiscovery)
      : this.pendingDiscovery
    // An endpoint's sign-in is the one its owner approved, never discovered:
    // what an authorization server published is taken only when it names
    // those same addresses (verifiedEndpointDiscovery), and adds what the
    // schema cannot say, such as where PCP registers itself.
    const fixed = endpointDiscovery(this.server)

    if (fixed) {
      return saved &&
        endpointAddressesMatch(saved.authorizationServerMetadata, this.server)
        ? saved
        : fixed
    }

    return saved
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (!this.interactive) {
      return
    }

    await this.writeFlowState({ verifier: codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const flow = await this.readFlowState()

    if (!flow?.verifier) {
      throw new PcpError(
        "state",
        "This authorization has expired. Start again.",
      )
    }

    return flow.verifier
  }

  private pendingDiscovery: OAuthDiscoveryState | undefined

  private async readFlowState(): Promise<FlowState | null> {
    const id = this.state()
    const row = id ? await db().oAuthState.findUnique({ where: { id } }) : null

    if (!row || row.serverId !== this.server.id) {
      return null
    }

    try {
      return JSON.parse(
        decryptString(
          this.ctx.dek,
          Buffer.from(row.codeVerifier),
          `oauth-state:${id}`,
        ),
      ) as FlowState
    } catch {
      return null
    }
  }

  private async writeFlowState(patch: Partial<FlowState>): Promise<void> {
    const id = this.state()
    const next: FlowState = {
      ...((await this.readFlowState()) ?? {}),
      ...(this.pendingDiscovery ? { discovery: this.pendingDiscovery } : {}),
      ...patch,
    }
    const blob = asBytes(
      encryptString(this.ctx.dek, JSON.stringify(next), `oauth-state:${id}`),
    )
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS)

    await db().oAuthState.upsert({
      where: { id },
      create: {
        id,
        serverId: this.server.id,
        codeVerifier: blob,
        redirectUri: this.options.redirectUrl,
        expiresAt,
      },
      update: { codeVerifier: blob, expiresAt },
    })
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier" || scope === "discovery") {
      return
    }

    await this.updateStore((store) => {
      const next = { ...store }

      if (scope === "tokens" || scope === "all") {
        delete next.tokens
        delete next.tokensSavedAt
        void db()
          .mcpServer.update({
            where: { id: this.server.id },
            data: { oauthConnectedAt: null },
          })
          .catch(() => {})
      }

      if (
        (scope === "client" || scope === "all") &&
        !this.server.oauthClientId
      ) {
        delete next.client
      }

      return next
    })
  }

  private async readStore(): Promise<OAuthStore> {
    if (!this.server.oauthTokensId) {
      return {}
    }

    try {
      return JSON.parse(
        await revealSecret(this.ctx, this.server.oauthTokensId),
      ) as OAuthStore
    } catch {
      return {}
    }
  }

  private async updateStore(
    change: (store: OAuthStore) => OAuthStore,
  ): Promise<void> {
    const next = change(await this.readStore())
    const { id } = await writeManagedSecret(this.ctx, {
      name: managedSecretName(this.server),
      description: `OAuth tokens PCP holds for ${this.server.name}.`,
      value: JSON.stringify(next),
    })

    if (this.server.oauthTokensId !== id) {
      this.server.oauthTokensId = id
      await db().mcpServer.update({
        where: { id: this.server.id },
        data: { oauthTokensId: id },
      })
    }
  }
}

/**
 * An API endpoint's sign-in, as discovery would have found it: the addresses
 * stored from its schema's oauth2 flow when the owner approved it. There is
 * no issuer: a schema names addresses, not the server's identity, so the SDK
 * takes the sign-in address's origin as the authorization server, which is
 * also what the owner's client is bound to (SEP-2352). And a resource of the
 * API's own address, so the SDK does not look for metadata the API does not
 * publish.
 */
export function endpointDiscovery(
  server: Pick<
    McpServer,
    "kind" | "url" | "oauthAuthorizationUrl" | "oauthTokenUrl"
  >,
): OAuthDiscoveryState | undefined {
  if (
    server.kind !== "openapi" ||
    !server.oauthAuthorizationUrl ||
    !server.oauthTokenUrl
  ) {
    return undefined
  }

  return {
    authorizationServerUrl: new URL(server.oauthAuthorizationUrl).origin,
    authorizationServerMetadata: {
      authorization_endpoint: server.oauthAuthorizationUrl,
      token_endpoint: server.oauthTokenUrl,
      response_types_supported: ["code"],
    } as OAuthDiscoveryState["authorizationServerMetadata"],
    resourceMetadata: { resource: server.url },
  }
}

/**
 * Whether metadata an authorization server published names the sign-in and
 * token addresses an endpoint was approved with, and no others. PCP signs in
 * only where the owner saw, so this is the test for taking anything else the
 * metadata says.
 */
export function endpointAddressesMatch(
  metadata:
    { authorization_endpoint?: string; token_endpoint?: string } | undefined,
  server: Pick<McpServer, "oauthAuthorizationUrl" | "oauthTokenUrl">,
): boolean {
  const same = (given: string | undefined, approved: string | null) => {
    try {
      return (
        given !== undefined &&
        approved !== null &&
        new URL(given).href === new URL(approved).href
      )
    } catch {
      return false
    }
  }

  return (
    same(metadata?.authorization_endpoint, server.oauthAuthorizationUrl) &&
    same(metadata?.token_endpoint, server.oauthTokenUrl)
  )
}

/**
 * An endpoint's sign-in, with what its authorization server publishes about
 * itself (RFC 8414) when that agrees with the addresses the owner approved:
 * the registration endpoint, the client authentication methods, the scopes.
 * That is how PCP finds out a provider lets it register itself, which an
 * OpenAPI schema has no way to say. Metadata that names other addresses is
 * not used; `elsewhere` says where it pointed, for the owner. Anything that
 * goes wrong reading it leaves the approved sign-in as it was. The request
 * goes under the endpoint's address rule, like its other OAuth requests.
 */
export async function verifiedEndpointDiscovery(
  server: McpServer,
  fixed: OAuthDiscoveryState,
): Promise<{
  discovery: OAuthDiscoveryState
  elsewhere: { authorization: string; token: string } | null
}> {
  let metadata: Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>

  try {
    metadata = await discoverAuthorizationServerMetadata(
      fixed.authorizationServerUrl,
      { fetchFn: oauthFetch(server) },
    )
  } catch {
    return { discovery: fixed, elsewhere: null }
  }

  if (!metadata) {
    return { discovery: fixed, elsewhere: null }
  }

  if (endpointAddressesMatch(metadata, server)) {
    return {
      discovery: { ...fixed, authorizationServerMetadata: metadata },
      elsewhere: null,
    }
  }

  return {
    discovery: fixed,
    elsewhere: {
      authorization: String(metadata.authorization_endpoint),
      token: String(metadata.token_endpoint),
    },
  }
}

/**
 * How PCP talks to an endpoint's authorization server: under the endpoint's
 * address rule, like its calls, since the token address came from a schema.
 * Undefined means the SDK's own fetch.
 */
export function oauthFetch(
  server: Pick<McpServer, "kind" | "publicOnly">,
): FetchLike | undefined {
  if (server.kind !== "openapi" || !server.publicOnly) {
    return undefined
  }

  return (url, init) => {
    const body = init?.body

    return send(
      String(url),
      {
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body:
          typeof body === "string"
            ? body
            : body instanceof URLSearchParams
              ? body.toString()
              : undefined,
        signal: init?.signal ?? undefined,
      },
      { publicOnly: true },
    )
  }
}

/** Renewed this long before it runs out, so a call does not race the clock. */
const RENEW_MARGIN_MS = 60_000

/**
 * The access token an OAuth endpoint's call carries, renewed first when it
 * has run out (or `renew` says the API refused it). Without a token, or one
 * that cannot be renewed, the endpoint needs connecting: UnauthorizedError,
 * as for an MCP server.
 */
async function endpointToken(
  ctx: VaultContext,
  server: McpServer,
  { publicUrl, renew = false }: { publicUrl: string; renew?: boolean },
): Promise<{ access: string; refresh: string | undefined }> {
  const provider = new PcpOAuthProvider(ctx, server, {
    redirectUrl: oauthRedirectUrl(publicUrl),
    publicUrl,
  })
  const held = await provider.tokenSet()
  let tokens = held.tokens
  const signIn = `${server.name} needs to be connected in PCP.`

  if (!server.oauthConnectedAt || !tokens?.access_token) {
    throw new UnauthorizedError(signIn)
  }

  const { expiresAt } = tokenLifetime(tokens, held.savedAt)
  const expired =
    expiresAt !== null && expiresAt.getTime() - RENEW_MARGIN_MS <= Date.now()

  if (renew || expired) {
    if (!tokens.refresh_token) {
      // Nothing to renew with: what PCP holds is over, and saying it is
      // connected would be untrue.
      if (expired) {
        await db().mcpServer.update({
          where: { id: server.id },
          data: { oauthConnectedAt: null },
        })
      }

      throw new UnauthorizedError(signIn)
    }

    // A client PCP registered itself renews with the methods its server
    // published; the owner's client keeps the approved sign-in as it is.
    const fixed = server.oauthClientId ? undefined : endpointDiscovery(server)

    if (fixed) {
      await provider.saveDiscoveryState(
        (await verifiedEndpointDiscovery(server, fixed)).discovery,
      )
    }

    // A refresh token is spent on the way: the SDK saves the new set, or
    // forgets the old one and asks for a sign-in nobody can give here.
    const result = await auth(provider, {
      serverUrl: server.url,
      scope: server.oauthScope ?? undefined,
      fetchFn: oauthFetch(server),
    })

    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError(signIn)
    }

    ;({ tokens } = await provider.tokenSet())

    if (!tokens?.access_token) {
      throw new UnauthorizedError(signIn)
    }
  }

  return { access: tokens.access_token, refresh: tokens.refresh_token }
}

/**
 * What the owner is told about a connection: whether PCP can renew it on
 * its own, and when the access it has runs out. Null when not connected.
 */
export type OAuthConnection = {
  renewable: boolean
  expiresAt: Date | null
  /** Not renewable, but a new sign-in would be: PCP asks for it now. */
  reconnectRenews: boolean
}

export async function describeOAuthConnection(
  ctx: VaultContext,
  server: McpServer,
): Promise<OAuthConnection | null> {
  if (server.authType !== "oauth" || !server.oauthConnectedAt) {
    return null
  }

  const provider = new PcpOAuthProvider(ctx, server, {
    redirectUrl: "",
    publicUrl: "",
  })
  const { tokens, savedAt, issuer } = await provider.tokenSet()

  if (!tokens) {
    return null
  }

  const lifetime = tokenLifetime(tokens, savedAt)

  return {
    ...lifetime,
    // A sign-in from before PCP asked this provider for renewable access
    // (signInDefaults) is fixed by signing in again.
    reconnectRenews:
      !lifetime.renewable && issuer !== undefined && !!signInDefaults(issuer),
  }
}

export async function forgetOAuthTokens(
  ctx: VaultContext,
  server: McpServer,
): Promise<void> {
  if (server.oauthTokensId) {
    await deleteManagedSecret(ctx, server.oauthTokensId)
  }

  await db().mcpServer.update({
    where: { id: server.id },
    data: {
      oauthTokensId: null,
      oauthConnectedAt: null,
      status: "unknown",
      statusMessage: "",
    },
  })
}

async function authHeaders(
  ctx: VaultContext,
  server: McpServer,
): Promise<Record<string, string>> {
  return (await credential(ctx, server)).headers
}

/**
 * What PCP sends to authenticate to a server: the headers its secrets go in
 * (the first on the server row, any further ones after it), and the values
 * that would give a secret away if an answer repeated them (each secret
 * itself, and each header as sent). A login (basic authentication) also
 * carries the user name and password, for a protocol that signs in with
 * them rather than with a header (IMAP, SMTP).
 */
export type Credential = {
  headers: Record<string, string>
  redact: string[]
  login: { username: string; password: string } | null
}

async function credential(
  ctx: VaultContext,
  server: McpServer,
  {
    publicUrl,
    renew = false,
  }: {
    /** Needed for an OAuth token PCP sends itself, which may be renewed. */
    publicUrl?: string
    renew?: boolean
  } = {},
): Promise<Credential> {
  if (server.authType === "basic") {
    return basicCredential(ctx, server)
  }

  // An MCP server's OAuth token is the SDK transport's to send; an API
  // endpoint's and a mail account's, PCP's own.
  if (
    server.authType === "oauth" &&
    (server.kind === "openapi" || isMailKind(server.kind))
  ) {
    const token = await endpointToken(ctx, server, {
      publicUrl: publicUrl ?? "",
      renew,
    })
    const value = `Bearer ${token.access}`

    return {
      headers: { Authorization: value },
      redact: [token.access, value, ...(token.refresh ? [token.refresh] : [])],
      login: null,
    }
  }

  if (server.authType !== "header") {
    return { headers: {}, redact: [], login: null }
  }

  if (!server.authSecretId || !server.authHeaderName) {
    throw new PcpError("state", `${server.name} has no secret configured.`)
  }

  const parts = [
    {
      secretId: server.authSecretId,
      headerName: server.authHeaderName,
      valueTemplate: server.authValueTemplate ?? "{{secret}}",
    },
    ...(await extraAuthHeaders(server.id)),
  ]
  const headers: Record<string, string> = {}
  const redact: string[] = []

  for (const part of parts) {
    // A secret deleted from under a header leaves it without one.
    if (!part.secretId) {
      throw new PcpError(
        "state",
        `${server.name} has no secret configured for its ${part.headerName} header.`,
      )
    }

    const secret = await readSecretValue(ctx, part.secretId)
    const value = renderAuthValue(part.valueTemplate, secret)

    // fetch refuses these, and its error message quotes the whole value: the
    // key would end up in the status shown on the Servers page, in the log
    // and in what the assistant is told. Say it without the value.
    if (/[\u0000\r\n]/.test(value)) {
      throw new PcpError(
        "state",
        `${server.name}'s secret has a line break or another character a header cannot carry, so PCP cannot send it. Check the secret's value.`,
      )
    }

    headers[part.headerName] = value
    redact.push(secret, value)
  }

  return { headers, redact, login: null }
}

async function basicCredential(
  ctx: VaultContext,
  server: McpServer,
): Promise<Credential> {
  if (!server.authSecretId || !server.authUsername) {
    throw new PcpError(
      "state",
      `${server.name} has no user name and secret configured.`,
    )
  }

  const password = await readSecretValue(ctx, server.authSecretId)

  // A line break would end an IMAP login line early, and a header cannot
  // carry one: say so without the value.
  if (/[\u0000\r\n]/.test(password)) {
    throw new PcpError(
      "state",
      `${server.name}'s secret has a line break or another character PCP cannot send. Check the secret's value.`,
    )
  }

  const token = Buffer.from(`${server.authUsername}:${password}`).toString(
    "base64",
  )

  return {
    headers: { Authorization: `Basic ${token}` },
    redact: [password, token, `Basic ${token}`],
    login: { username: server.authUsername, password },
  }
}

/**
 * What a mail account signs in with: its login, its bearer token, or the
 * OAuth token PCP holds for it, renewed by onUnauthorized when the server
 * refuses it (null then means the owner has to connect it again).
 */
async function mailCredential(
  ctx: VaultContext,
  server: McpServer,
  { publicUrl }: { publicUrl: string },
): Promise<MailCredential> {
  const { headers, redact, login } = await credential(ctx, server, {
    publicUrl,
  })

  if (server.authType !== "oauth") {
    return { headers, redact, login }
  }

  return {
    headers,
    redact,
    login: null,
    onUnauthorized: async () => {
      try {
        const renewed = await credential(ctx, server, {
          publicUrl,
          renew: true,
        })
        return { headers: renewed.headers, redact: renewed.redact }
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          return null
        }

        throw error
      }
    },
  }
}

export type UpstreamConnection = {
  client: Client
  transport: StreamableHTTPClientTransport
  provider: PcpOAuthProvider | null
  /** The server's last answer that was not a success, if any. */
  refusal: () => Refusal | undefined
  close: () => Promise<void>
}

/**
 * What the server said when it turned a request down. The SDK's error keeps
 * the status and the body, but not the WWW-Authenticate header, which is
 * where a server says why it refused a token.
 */
type Refusal = { status: number; challenge: string | null }

/** The refusal behind an error thrown while connecting. */
const refusals = new WeakMap<object, Refusal>()

/**
 * A connected client for one server. The caller closes it. An OAuth server
 * without tokens throws UnauthorizedError; the owner connects it from the UI.
 */
export async function openUpstream(
  ctx: VaultContext,
  server: McpServer,
  { publicUrl }: { publicUrl: string },
): Promise<UpstreamConnection> {
  const provider =
    server.authType === "oauth"
      ? new PcpOAuthProvider(ctx, server, {
          redirectUrl: oauthRedirectUrl(publicUrl),
          publicUrl,
        })
      : null

  const headers = await authHeaders(ctx, server)
  const endpoint = new URL(server.url)
  let refusal: Refusal | undefined
  const transport = new StreamableHTTPClientTransport(endpoint, {
    // Never cached: these are live calls carrying credentials. It also keeps
    // a host that wraps fetch with a cache (Next.js) out of the way when the
    // SDK aborts its event stream on close.
    requestInit: { headers, cache: "no-store" },
    ...(provider ? { authProvider: provider } : {}),
    fetch: async (url, init) => {
      const response = await fetch(url, init)

      // Only the server's own answers: not the sign-in's discovery or token
      // requests, which the SDK reports itself.
      if (!response.ok && String(url) === endpoint.href) {
        refusal = {
          status: response.status,
          challenge: response.headers.get("www-authenticate"),
        }
      }

      return response
    },
  })
  const client = new Client(PCP_CLIENT_INFO)

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
  } catch (error) {
    await transport.close().catch(() => {})

    if (refusal && error !== null && typeof error === "object") {
      refusals.set(error, refusal)
    }

    throw error
  }

  return {
    client,
    transport,
    provider,
    refusal: () => refusal,
    close: async () => {
      await client.close().catch(() => {})
    },
  }
}

export type { SyncResult }

/**
 * Reads the server's tool list into the catalogue. Tools that disappeared
 * are removed; the owner's description overrides survive a resync.
 */
export async function syncServerTools(
  ctx: VaultContext,
  server: McpServer,
  {
    publicUrl,
    byOwner = false,
  }: {
    publicUrl: string
    /** The owner asked for this read (see syncEndpointTools). */
    byOwner?: boolean
  },
): Promise<SyncResult> {
  if (server.kind === "openapi") {
    return syncEndpointTools(server, { byOwner })
  }

  if (isMailKind(server.kind)) {
    let signIn: MailCredential

    try {
      signIn = await mailCredential(ctx, server, { publicUrl })
    } catch (error) {
      const result = describeFailure(server, error, null)
      await setServerStatus(server.id, result.status, result.message)
      return { ...result, toolCount: 0 }
    }

    return syncMailTools(server, signIn)
  }

  let connection: UpstreamConnection | null = null

  try {
    connection = await openUpstream(ctx, server, { publicUrl })
    const { tools } = await connection.client.listTools(undefined, {
      timeout: CONNECT_TIMEOUT_MS,
    })
    const toolCount = await storeTools(
      server.id,
      tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    )

    // The upstream's own description is a fallback for a server the owner
    // has not described yet.
    const instructions = connection.client.getInstructions()?.trim()
    if (instructions && !server.description) {
      await db().mcpServer.update({
        where: { id: server.id },
        data: { description: instructions.slice(0, 1000) },
      })
    }

    await setServerStatus(server.id, "ok", "", { lastSyncedAt: new Date() })

    return { status: "ok", message: "", toolCount }
  } catch (error) {
    const result = describeFailure(server, error, connection)
    await setServerStatus(server.id, result.status, result.message)

    return { ...result, toolCount: 0 }
  } finally {
    await connection?.close()
  }
}

/**
 * One API endpoint call with its credential. An OAuth endpoint whose token
 * the API refuses (401) gets one renewed token and one more try: a refused
 * request did nothing, so sending it again is safe.
 */
async function callEndpoint(
  ctx: VaultContext,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  { publicUrl }: { publicUrl: string },
): Promise<CallToolResult> {
  try {
    const { headers, redact } = await credential(ctx, server, { publicUrl })

    return await callEndpointTool(server, toolName, args, {
      authHeaders: headers,
      redact,
      ...(server.authType === "oauth"
        ? {
            renew: async () =>
              credential(ctx, server, { publicUrl, renew: true }),
          }
        : {}),
    })
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      const message = `${server.name} needs to be connected: open it in PCP and choose Connect.`
      await setServerStatus(server.id, "auth_required", message)
      throw new PcpError("unauthorized", message)
    }

    throw error
  }
}

export async function callServerTool(
  ctx: VaultContext,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  {
    publicUrl,
    keep,
    keepBytes,
    open,
  }: {
    publicUrl: string
    /** Keeps a long text whole for read_result (mail bodies, attachments). */
    keep?: ResultKeeper
    /** Keeps a file's bytes for the token (a mail attachment read). */
    keepBytes?: BytesKeeper
    /**
     * Opens a result the token kept, for the handles in the arguments
     * ({"$result": id}): they are replaced by what they stand for before
     * anything is sent, and an id the token has no result for is refused.
     */
    open?: ResultOpener
  },
): Promise<CallToolResult> {
  if (server.kind === "openapi") {
    return callEndpoint(
      ctx,
      server,
      toolName,
      open ? await resolveHandles(args, open) : args,
      { publicUrl },
    )
  }

  if (isMailKind(server.kind)) {
    let signIn: MailCredential

    try {
      signIn = await mailCredential(ctx, server, { publicUrl })
    } catch (error) {
      if (isPcpError(error)) {
        throw error
      }

      const failure = describeFailure(server, error, null)
      await setServerStatus(server.id, failure.status, failure.message)
      throw new PcpError(
        failure.status === "auth_required" ||
          failure.status === "client_required"
          ? "unauthorized"
          : "upstream",
        failure.message,
      )
    }

    return callMailTool(server, toolName, args, {
      credential: signIn,
      keep,
      keepBytes,
      open,
    })
  }

  // Before a connection is opened: an unknown id never reaches the server.
  const resolved = open ? await resolveHandles(args, open) : args
  let connection: UpstreamConnection | null = null

  try {
    connection = await openUpstream(ctx, server, { publicUrl })

    return await connection.client.callTool(
      { name: toolName, arguments: resolved },
      { timeout: CALL_TIMEOUT_MS },
    )
  } catch (error) {
    const failure = describeFailure(server, error, connection)
    await setServerStatus(server.id, failure.status, failure.message)

    // "unauthorized" tells the gateway the server needs connecting (or its
    // credential was refused), not that it could not be reached. A server
    // that turned a signed-in request down needs the owner, but not a
    // sign-in.
    throw new PcpError(
      failure.status === "auth_required" || failure.status === "client_required"
        ? "unauthorized"
        : "upstream",
      failure.message,
    )
  } finally {
    await connection?.close()
  }
}

function describeFailure(
  server: McpServer,
  error: unknown,
  connection: UpstreamConnection | null,
): {
  status: "auth_required" | "client_required" | "refused" | "error"
  message: string
} {
  if (SdkHttpError.isInstance(error)) {
    const { status, text } = error.data ?? { status: 0 }
    const refusal =
      connection?.refusal() ??
      (typeof error === "object" ? refusals.get(error) : undefined)
    const reason = refusalReason(
      refusal?.status === status ? refusal.challenge : null,
      typeof text === "string" ? text : null,
    )
    const said = `HTTP ${status}${reason ? `: ${reason}` : ""}`

    if (status === 401 || status === 403) {
      return { status: "refused", message: refusedMessage(server, said) }
    }

    return {
      status: "error",
      message: `${server.name} could not be reached (${said}).`,
    }
  }

  if (error instanceof UnauthorizedError) {
    // Still true until the owner gives it a client: a sync or a call does
    // not change what the server allows.
    if (
      server.authType === "oauth" &&
      server.status === "client_required" &&
      !server.oauthClientId
    ) {
      return { status: "client_required", message: server.statusMessage }
    }

    return {
      status: "auth_required",
      message:
        server.authType === "oauth"
          ? `${server.name} needs to be connected: open it in PCP and choose Connect.`
          : `${server.name} rejected the credentials PCP sent.`,
    }
  }

  const message = error instanceof Error ? error.message : String(error)

  return {
    status: "error",
    message: `${server.name} could not be reached: ${message}`.slice(0, 500),
  }
}

/**
 * Why a server turned a request down, in its own words: the reason in its
 * WWW-Authenticate challenge, or an error object in the body. Never the body
 * itself, which can be a whole answer (Google sends the tool list with its
 * 401).
 */
export function refusalReason(
  challenge: string | null,
  body: string | null,
): string | null {
  const fromChallenge =
    challenge?.match(/error_description="([^"]*)"/)?.[1] ??
    challenge?.match(/error="([^"]*)"/)?.[1]
  let fromBody: unknown

  try {
    const parsed = JSON.parse(body ?? "") as {
      error?: unknown
      error_description?: unknown
    }
    fromBody =
      typeof parsed.error === "string"
        ? (parsed.error_description ?? parsed.error)
        : (parsed.error as { message?: unknown } | undefined)?.message
  } catch {
    // Not JSON: nothing PCP can quote safely.
  }

  const reason = fromChallenge ?? (typeof fromBody === "string" ? fromBody : "")
  const clean = reason
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 200)

  return clean || null
}

/** What to tell the owner about a server that refused a request. */
function refusedMessage(server: McpServer, said: string): string {
  if (server.authType === "header") {
    return `${server.name} refused the secret PCP sent (${said}). Check the secret under Settings, then choose Refresh tools.`
  }

  if (server.authType !== "oauth") {
    return `${server.name} refused PCP's request (${said}). It may need a secret or a sign-in: set one under Settings.`
  }

  // Google's MCP servers are APIs of their own (gmailmcp.googleapis.com
  // next to gmail.googleapis.com), and refuse with a bare 403 until both
  // are enabled in the project of the client the token came from.
  const host = new URL(server.url).hostname
  const google = host.endsWith(".googleapis.com")
    ? ` With Google, enable both the service's API and its MCP API (${host}) in the Google Cloud project your OAuth client belongs to (APIs & Services, then Library); some MCP APIs need the project enrolled in Google's preview first.`
    : ""

  return `${server.name} refused PCP's request although PCP is signed in (${said}). The account or OAuth client you signed in with is not allowed to use it yet.${google} Once that is fixed, choose Refresh tools.`
}
