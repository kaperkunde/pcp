import type { CallToolResult } from "@modelcontextprotocol/server"

import { oauthStartUrl } from "./upstream"

/**
 * An OAuth server the owner has to sign in to before its tools work. The
 * assistant is handed a link to the server's page in PCP, where Connect
 * starts the sign-in (it needs the owner's PCP session, which that page
 * asks for first), and check_server to wait for it. `structuredContent`
 * carries the same in fields, for clients that read them.
 */

export type ConnectLinks = {
  serverId: string
  slug: string
  name: string
  /** PCP's OAuth start route, which Connect on the server's page opens. */
  startUrl: string
  /** The server's page in PCP: Connect, or what to set up first. */
  pageUrl: string
}

export type ServerState = {
  id: string
  name: string
  slug: string
  connected: boolean
  status: string
  toolCount: number
}

export function connectLinks(
  server: { id: string; slug: string; name: string },
  publicUrl: string,
): ConnectLinks {
  const base = publicUrl.replace(/\/+$/, "")

  return {
    serverId: server.id,
    slug: server.slug,
    name: server.name,
    startUrl: oauthStartUrl(base, server.id),
    pageUrl: `${base}/servers/${server.id}`,
  }
}

/** An OAuth server that needs the owner to sign in before it can be used. */
export function connectResult(
  server: { id: string; slug: string; name: string; status?: string },
  publicUrl: string,
  { lead = "Not done yet", state }: { lead?: string; state?: ServerState } = {},
): CallToolResult {
  const connect = connectLinks(server, publicUrl)
  const wait = `Then call check_server with server "${server.slug}": it waits while they do, and answers once it is connected. Then try again.`

  // The server will not let PCP register itself: signing in cannot work
  // until the owner creates a client with the provider and gives it to PCP.
  // Its page says how.
  const said =
    server.status === "client_required"
      ? `${lead}: ${server.name} needs an OAuth client from the owner before it can be connected, because it does not let PCP register itself. Give the owner this link, to open signed in to PCP: ${connect.pageUrl} It says what to create with the provider and where to enter it; then they choose Connect. ${wait}`
      : `${lead}: ${server.name} needs connecting before its tools can be used. Give the owner this link, to open signed in to PCP and choose Connect: ${connect.pageUrl} ${wait}`

  return {
    content: [{ type: "text", text: said }],
    structuredContent: {
      kind: "connect",
      connect,
      ...(state ? { server: state } : {}),
    },
  }
}

/** Whether a result is connectResult's: the call did not reach the server. */
export function isConnectResult(result: CallToolResult): boolean {
  return (
    (result.structuredContent as { kind?: unknown } | undefined)?.kind ===
    "connect"
  )
}
