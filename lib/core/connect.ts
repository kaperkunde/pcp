import type { CallToolResult } from "@modelcontextprotocol/server"

import { linkLabel, linkLastText, nextMessageCheck } from "./owner-link"
import { noteOwnerAsked } from "./request-log"
import type { ConnectLinks, NeedsOwner, ServerState } from "./tools/outcome"
import { oauthStartUrl } from "./upstream"

/**
 * An OAuth server the owner has to sign in to before its tools work. The
 * assistant is handed a link to the server's page in PCP, where Connect
 * starts the sign-in (it needs the owner's PCP session, which that page
 * asks for first), to end its reply with, and check_server to call on the
 * owner's next message, whatever it says. `structuredContent`
 * carries the same in fields, as every call that waits for the owner does
 * (tools/outcome.ts NEEDS_OWNER, reason "connect").
 */

export type { ConnectLinks, ServerState }

/** The owner's Google page: one sign-in for every Google server. */
export const GOOGLE_PAGE = "/servers/google"

export function connectLinks(
  server: { id: string; slug: string; name: string; authType?: string },
  publicUrl: string,
): ConnectLinks {
  const base = publicUrl.replace(/\/+$/, "")

  // A Google server is connected on the one Google page, where the owner
  // signs in once for all of them: that page is the link and the start.
  if (server.authType === "google") {
    return {
      serverId: server.id,
      slug: server.slug,
      name: server.name,
      startUrl: `${base}${GOOGLE_PAGE}`,
      pageUrl: `${base}${GOOGLE_PAGE}`,
    }
  }

  return {
    serverId: server.id,
    slug: server.slug,
    name: server.name,
    startUrl: oauthStartUrl(base, server.id),
    pageUrl: `${base}/servers/${server.id}`,
  }
}

/** How the assistant hands a link to the owner (owner-link.ts). */
export { linkLastText }

/** An OAuth server that needs the owner to sign in before it can be used. */
export function connectResult(
  server: {
    id: string
    slug: string
    name: string
    status?: string
    authType?: string
  },
  publicUrl: string,
  { lead = "Not done yet", state }: { lead?: string; state?: ServerState } = {},
): CallToolResult {
  const connect = connectLinks(server, publicUrl)
  const google = server.authType === "google"
  const label = google
    ? "Connect Google in PCP"
    : server.status === "client_required"
      ? `Set up ${server.name} in PCP`
      : `Connect ${server.name} in PCP`
  noteOwnerAsked()
  const wait = `${nextMessageCheck(`check_server with server "${server.slug}"`, "it is still not connected")} It answers once it is connected (and waits a little if they are still signing in). Then try again.`

  // The server will not let PCP register itself: signing in cannot work
  // until the owner creates a client with the provider and gives it to PCP.
  // Its page says how.
  const said = google
    ? `${lead}: ${server.name} needs Google connected before its tools can be used. The owner opens the link below signed in to PCP and chooses Connect; one sign-in covers every Google server. ${wait}\n\n${linkLastText(connect.pageUrl, label)}`
    : server.status === "client_required"
      ? `${lead}: ${server.name} needs an OAuth client from the owner before it can be connected, because it does not let PCP register itself. The page at the link below, opened signed in to PCP, says what to create with the provider and where to enter it; then they choose Connect. ${wait}\n\n${linkLastText(connect.pageUrl, label)}`
      : `${lead}: ${server.name} needs connecting before its tools can be used. The owner opens the link below signed in to PCP and chooses Connect. ${wait}\n\n${linkLastText(connect.pageUrl, label)}`

  const owner: NeedsOwner = {
    kind: "needs_owner",
    reason: "connect",
    url: connect.pageUrl,
    label: linkLabel(label),
    connect,
    ...(state ? { server: state } : {}),
  }

  return {
    content: [{ type: "text", text: said }],
    structuredContent: owner,
  }
}

/** Whether a result is connectResult's: the call did not reach the server. */
export function isConnectResult(result: CallToolResult): boolean {
  const structured = result.structuredContent as
    { kind?: unknown; reason?: unknown } | undefined

  return structured?.kind === "needs_owner" && structured.reason === "connect"
}
