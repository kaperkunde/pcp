import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PageHeader } from "@/components/page-header"
import { TokenDetail } from "@/components/token-detail"
import { ButtonLink } from "@/components/ui/button"
import { getApiToken, listApiTokens } from "@/lib/core/api-tokens"
import { isPcpError } from "@/lib/core/errors"
import { listOpenPermissions } from "@/lib/core/permissions"
import { listServers } from "@/lib/core/servers"
import { listTokenToolAccess } from "@/lib/core/tool-access"
import { listFetchRules } from "@/lib/core/web-fetch"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "API token" }

export default async function TokenPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params

  let token: Awaited<ReturnType<typeof getApiToken>>

  try {
    token = await getApiToken(ctx, id)
  } catch (error) {
    if (isPcpError(error) && error.code === "not_found") {
      notFound()
    }

    throw error
  }

  const publicUrl = await publicUrlFor(ctx)
  const [servers, access, tokens, waiting] = await Promise.all([
    listServers(ctx),
    listTokenToolAccess(ctx, id),
    listApiTokens(ctx),
    listOpenPermissions(ctx, id, publicUrl),
  ])
  // The browser follows the token's web fetch sites: a token that reaches
  // it has them, web fetch or not.
  const reachesBrowser = servers.some(
    (server) =>
      server.kind === "browser" &&
      (token.allowAllServers ||
        token.servers.some((picked) => picked.id === server.id)),
  )
  const fetchRules =
    token.webFetch || reachesBrowser ? await listFetchRules(ctx, id) : null

  return (
    <>
      <PageHeader
        title={token.name}
        description={`API token ${token.prefix}… Choose which tools an assistant using it may run, which ask you first, and which are blocked.`}
        action={
          <div className="flex gap-2">
            <ButtonLink
              href={`/log?token=${encodeURIComponent(id)}`}
              variant="outline"
              size="sm"
            >
              Its log
            </ButtonLink>
            <ButtonLink href="/tokens" variant="outline" size="sm">
              All tokens
            </ButtonLink>
          </div>
        }
      />
      <TokenDetail
        token={token}
        servers={servers.map(({ id, name, kind }) => ({ id, name, kind }))}
        access={access}
        otherTokens={tokens
          .filter((other) => other.id !== id)
          .map(({ id, name }) => ({ id, name }))}
        waiting={waiting.map((request) => ({
          id: request.id,
          review: request.kind === "access",
          title: request.title,
          lines: request.lines,
          warning: request.warning,
          decisions: request.decisions,
          secret: request.secretToEnter,
          every:
            request.kind === "memory_share" && request.memory
              ? { asked: request.memory.always }
              : null,
        }))}
        endpointUrl={`${publicUrl}/mcp`}
        fetchRules={fetchRules}
        browser={reachesBrowser}
      />
    </>
  )
}
