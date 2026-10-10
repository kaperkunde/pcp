import { notFound } from "next/navigation"

import { getApiToken, type ApiTokenSummary } from "@/lib/core/api-tokens"
import type { VaultContext } from "@/lib/core/context"
import { isPcpError } from "@/lib/core/errors"
import { listServers, type ServerKind } from "@/lib/core/servers"

/**
 * What both of a token's pages start from: the token (or a 404), the
 * servers it could reach as the scope fields want them, and whether it
 * reaches the browser, which follows its web fetch sites.
 */
export async function loadToken(ctx: VaultContext, id: string) {
  let token: ApiTokenSummary

  try {
    token = await getApiToken(ctx, id)
  } catch (error) {
    if (isPcpError(error) && error.code === "not_found") {
      notFound()
    }

    throw error
  }

  const servers = (await listServers(ctx)).map(({ id, name, kind }) => ({
    id,
    name,
    kind,
  }))
  const reaches = (serverId: string) =>
    token.allowAllServers ||
    token.servers.some((picked) => picked.id === serverId)
  // The browser follows the token's web fetch sites: a token that reaches
  // it has them, web fetch or not.
  const browser = servers.some(
    (server) => server.kind === "browser" && reaches(server.id),
  )
  const kinds: Record<string, ServerKind> = Object.fromEntries(
    servers.map((server) => [server.id, server.kind]),
  )
  const expired = token.expiresAt !== null && token.expiresAt < new Date()

  return {
    token,
    servers,
    kinds,
    browser,
    expired,
    /** A revoked token can no longer change; an expired one still can. */
    locked: token.revokedAt !== null,
  }
}
