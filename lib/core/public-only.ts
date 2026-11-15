import { PUBLIC_ONLY_ANCHOR } from "./constants"
import { PcpError } from "./errors"
import { linkLastText } from "./owner-link"

/**
 * A public-only server (an MCP server or an API endpoint an assistant
 * proposed, until the owner allows private addresses) refusing an address,
 * and the link that takes the owner to the switch that lifts it: the
 * server's page, at "Public addresses only", outside Advanced.
 */

/** A public-only endpoint's refusal: its rule at work, not an outage. */
export class PublicOnlyRefusal extends PcpError {
  constructor(message: string) {
    super("forbidden", message)
  }
}

/** The server's page, scrolled to its "Public addresses only" switch. */
export function publicOnlyUrl(publicUrl: string, serverId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/servers/${encodeURIComponent(serverId)}#${PUBLIC_ONLY_ANCHOR}`
}

/**
 * The refusal with the link to the switch, last, for the assistant to hand
 * the owner. Without PCP's address (a check made outside a request) it is
 * the refusal alone.
 */
export function withPublicOnlyLink(
  message: string,
  server: { id: string; name: string },
  publicUrl: string,
): string {
  if (!publicUrl) {
    return message
  }

  return `${message}\n${linkLastText(
    publicOnlyUrl(publicUrl, server.id),
    `Allow private addresses for ${server.name}`,
  )}`
}
