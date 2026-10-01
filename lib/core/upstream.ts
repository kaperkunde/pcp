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
  deleteManagedSecret,
  readSecretValue,
  revealSecret,
  writeManagedSecret,
} from "./secrets"
import { renderAuthValue, setServerStatus } from "./servers"

/**
 * Talking to the servers in the registry: opening a connection with the
 * right credentials, reading their tool lists and calling their tools. API
 * endpoints (kind "openapi") branch off to lib/core/endpoints.ts, which
 * makes plain HTTP calls with the header this module builds.
 *
 * Credentials are decrypted here, used for the one connection and dropped.
 * Nothing in this module returns a secret to a caller.
 */

export const PCP_CLIENT_INFO = { name: "pcp", version: "0.1.0" }

const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000

export function oauthCallbackUrl(publicUrl: string, serverId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/servers/${serverId}/oauth/callback`
}

export function managedSecretName(server: Pick<McpServer, "id">): string {
  return `oauth/${server.id}`
}

/** What an authorization in flight needs on the callback leg. */
type FlowState = {
  verifier?: string
  discovery?: OAuthDiscoveryState
}

type OAuthStore = {
  client?: StoredOAuthClientInformation
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
    },
  ) {}

  get redirectUrl(): string {
    return this.options.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "PCP",
      client_uri: this.options.publicUrl,
      software_id: "pcp",
      software_version: PCP_CLIENT_INFO.version,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.server.oauthClientSecretId
        ? "client_secret_post"
        : "none",
      ...(this.server.oauthScope ? { scope: this.server.oauthScope } : {}),
    }
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
      return {
        client_id: this.server.oauthClientId,
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

    return (await this.readStore()).client
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
  ): Promise<void> {
    if (this.server.oauthClientId) {
      return
    }

    await this.updateStore((store) => ({ ...store, client: clientInformation }))
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.readStore()).tokens
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

    this.authorizationUrl = authorizationUrl
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
 * The header a server's secret goes in, and the values that would give the
 * secret away if an answer repeated them (the secret itself, and the header
 * as sent).
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

  const secret = await readSecretValue(ctx, server.authSecretId)
  const value = renderAuthValue(
    server.authValueTemplate ?? "{{secret}}",
    secret,
  )

  return {
    headers: { [server.authHeaderName]: value },
    redact: [secret, value],
  }
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
          redirectUrl: oauthCallbackUrl(publicUrl, server.id),
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
  { publicUrl }: { publicUrl: string },
): Promise<SyncResult> {
  if (server.kind === "openapi") {
    return syncEndpointTools(server)
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

    throw new PcpError("upstream", failure.message)
  } finally {
    await connection?.close()
  }
}

function describeFailure(
  server: McpServer,
  error: unknown,
): { status: "auth_required" | "error"; message: string } {
  if (error instanceof UnauthorizedError) {
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
