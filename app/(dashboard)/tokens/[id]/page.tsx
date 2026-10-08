import type { Metadata } from "next"

import { LocalDate, RelativeDate } from "@/components/local-date"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { TokenAvatar } from "@/components/token-avatar"
import {
  TokenAllowances,
  TokenEnd,
  TokenReachForm,
  TokenWaiting,
} from "@/components/token-detail"
import { TokenTools } from "@/components/token-tools"
import { Badge } from "@/components/ui/badge"
import { ButtonLink } from "@/components/ui/button"
import { List, ListRow } from "@/components/ui/list"
import { listTokenAllowances } from "@/lib/core/allowances"
import { listOpenPermissions } from "@/lib/core/permissions"
import { listTokenToolAccess } from "@/lib/core/tool-access"
import { listFetchRules } from "@/lib/core/web-fetch"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

import { loadToken } from "./load-token"

export const metadata: Metadata = { title: "Assistant" }

/**
 * One assistant: what waits for the owner, what it reaches and may do, its
 * tools' levels, and a way to stop it. What is set once (expiry, every
 * tool's All tokens box, web sites and methods, what it may propose) is a
 * page down, under Advanced.
 */
export default async function TokenPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const { token, servers, kinds, browser, expired, locked } = await loadToken(
    ctx,
    id,
  )
  const publicUrl = await publicUrlFor(ctx)
  const [access, waiting, allowances, fetchRules] = await Promise.all([
    listTokenToolAccess(ctx, id),
    listOpenPermissions(ctx, id, publicUrl),
    listTokenAllowances(ctx, id),
    token.webFetch || browser ? listFetchRules(ctx, id) : null,
  ])
  const advanced = `/tokens/${id}/advanced`

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/tokens", label: "Assistants" }}
        icon={<TokenAvatar name={token.name} size="lg" dimmed={locked} />}
        title={token.name}
        description={
          <span className="flex flex-col gap-1">
            <span>
              {token.lastUsedAt ? (
                <>
                  Last used <RelativeDate value={token.lastUsedAt} />
                </>
              ) : (
                "Not used yet"
              )}
              {" · "}
              {token.expiresAt ? (
                <>
                  {expired ? "Expired" : "Expires"}{" "}
                  <LocalDate value={token.expiresAt} />
                </>
              ) : (
                "Never expires"
              )}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {token.revokedAt ? (
                <Badge variant="destructive">Revoked</Badge>
              ) : expired ? (
                <Badge variant="destructive">Expired</Badge>
              ) : null}
              {token.oauthClient
                ? `API token for ${token.oauthClient.name}, which signed in with OAuth.`
                : `API token ${token.prefix}…`}
              {locked ? " It is revoked; nothing about it can change." : null}
            </span>
          </span>
        }
        action={
          <ButtonLink
            href={`/log?token=${encodeURIComponent(id)}`}
            variant="secondary"
            size="sm"
          >
            Its log
          </ButtonLink>
        }
      />

      {waiting.length > 0 ? (
        <TokenWaiting
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
        />
      ) : null}

      {allowances.length > 0 ? (
        <TokenAllowances
          tokenId={id}
          allowances={allowances.map((allowance) => ({
            ...allowance,
            until: allowance.until.toISOString(),
          }))}
        />
      ) : null}

      <TokenReachForm
        token={token}
        servers={servers}
        locked={locked}
        sites={
          fetchRules
            ? { href: `${advanced}#web-pages`, count: fetchRules.sites.length }
            : null
        }
      />

      <TokenTools tokenId={id} access={access} kinds={kinds} locked={locked} />

      <List>
        <ListRow
          href={advanced}
          title="Advanced"
          description="Name, expiry, every tool's level for all tokens, web sites and methods, what it may propose, copying access"
        />
      </List>

      <TokenEnd
        token={{
          id,
          name: token.name,
          revoked: token.revokedAt !== null,
          expired,
          oauthClient: token.oauthClient?.name ?? null,
        }}
      />
    </PageColumn>
  )
}
