import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type OAuthClientMetadata,
  type OAuthClientProvider,
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
import { PcpError } from "./errors"
import {
  applyAuthorizeParams,
  oauthRedirectUrl,
  registrationMetadata,
  tokenLifetime,
} from "./oauth-client"
import {
  deleteManagedSecret,
  readSecretValue,
  revealSecret,
  writeManagedSecret,
} from "./secrets"
import { extraAuthHeaders, renderAuthValue, setServerStatus } from "./servers"
import { PCP_VERSION } from "./version"

/**
 * Talking to the servers in the registry: opening a connection with the
 * right credentials, reading their tool lists and calling their tools. API
 * endpoints (kind "openapi") branch off to lib/core/endpoints.ts, which
 * makes plain HTTP calls with the header this module builds.
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
  ) {}

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
  }> {
    const store = await this.readStore()
    return { tokens: store.tokens, savedAt: store.tokensSavedAt }
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

    this.authorizationUrl = applyAuthorizeParams(
      authorizationUrl,
      this.server.oauthAuthorizeParams,
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
    if (this.interactive) {
      return (await this.readFlowState())?.discovery ?? this.pendingDiscovery
    }

    return this.pendingDiscovery
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
 * What the owner is told about a connection: whether PCP can renew it on
 * its own, and when the access it has runs out. Null when not connected.
 */
export async function describeOAuthConnection(
  ctx: VaultContext,
  server: McpServer,
): Promise<{ renewable: boolean; expiresAt: Date | null } | null> {
  if (server.authType !== "oauth" || !server.oauthConnectedAt) {
    return null
  }

  const provider = new PcpOAuthProvider(ctx, server, {
    redirectUrl: "",
    publicUrl: "",
  })
  const { tokens, savedAt } = await provider.tokenSet()

  return tokens ? tokenLifetime(tokens, savedAt) : null
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
 * The headers a server's secrets go in (the first on the server row, any
 * further ones after it), and the values that would give a secret away if
 * an answer repeated them (each secret itself, and each header as sent).
 */
async function credential(
  ctx: VaultContext,
  server: McpServer,
): Promise<{ headers: Record<string, string>; redact: string[] }> {
  if (server.authType !== "header") {
    return { headers: {}, redact: [] }
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

  return { headers, redact }
}

export type UpstreamConnection = {
  client: Client
  transport: StreamableHTTPClientTransport
  provider: PcpOAuthProvider | null
  close: () => Promise<void>
}

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
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    // Never cached: these are live calls carrying credentials. It also keeps
    // a host that wraps fetch with a cache (Next.js) out of the way when the
    // SDK aborts its event stream on close.
    requestInit: { headers, cache: "no-store" },
    ...(provider ? { authProvider: provider } : {}),
  })
  const client = new Client(PCP_CLIENT_INFO)

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
  } catch (error) {
    await transport.close().catch(() => {})
    throw error
  }

  return {
    client,
    transport,
    provider,
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
    const result = describeFailure(server, error)
    await setServerStatus(server.id, result.status, result.message)

    return { ...result, toolCount: 0 }
  } finally {
    await connection?.close()
  }
}

export async function callServerTool(
  ctx: VaultContext,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  { publicUrl }: { publicUrl: string },
): Promise<CallToolResult> {
  if (server.kind === "openapi") {
    const { headers, redact } = await credential(ctx, server)
    return callEndpointTool(server, toolName, args, {
      authHeaders: headers,
      redact,
    })
  }

  let connection: UpstreamConnection | null = null

  try {
    connection = await openUpstream(ctx, server, { publicUrl })

    return await connection.client.callTool(
      { name: toolName, arguments: args },
      { timeout: CALL_TIMEOUT_MS },
    )
  } catch (error) {
    const failure = describeFailure(server, error)
    await setServerStatus(server.id, failure.status, failure.message)

    // "unauthorized" tells the gateway the server needs connecting (or its
    // credential was refused), not that it could not be reached.
    throw new PcpError(
      failure.status === "error" ? "upstream" : "unauthorized",
      failure.message,
    )
  } finally {
    await connection?.close()
  }
}

function describeFailure(
  server: McpServer,
  error: unknown,
): {
  status: "auth_required" | "client_required" | "error"
  message: string
} {
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
