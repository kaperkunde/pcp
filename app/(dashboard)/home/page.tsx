import { Plus } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

import { CopyableValue } from "@/components/copyable-value"
import { GetStarted } from "@/components/get-started"
import { RelativeDate } from "@/components/local-date"
import { PageHeader } from "@/components/page-header"
import { ServerStatusBadge } from "@/components/server-status-badge"
import { CountBadge, StatusDot } from "@/components/ui/badge"
import { ButtonLink } from "@/components/ui/button"
import { Card, CardDescription, CardTitle } from "@/components/ui/card"
import { IconTile, serverKindLabel } from "@/components/ui/icon-tile"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { listApiTokens } from "@/lib/core/api-tokens"
import { listPendingRequests } from "@/lib/core/permissions"
import { listServers } from "@/lib/core/servers"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Home" }

/** How many assistants Home names; the rest are a click away. */
const ASSISTANTS_SHOWN = 3

/**
 * Where the owner lands: what waits for them first, then the assistants
 * that use PCP, the address they connect to, and how each server is.
 */
export default async function HomePage() {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)
  const [pending, tokens, servers] = await Promise.all([
    listPendingRequests(ctx, publicUrl),
    listApiTokens(ctx),
    listServers(ctx),
  ])
  const now = new Date()
  const live = tokens
    .filter(
      (token) =>
        !token.revokedAt && (!token.expiresAt || token.expiresAt > now),
    )
    .sort(
      (a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0),
    )
  const host = new URL(publicUrl).host

  return (
    <>
      <PageHeader
        title="Home"
        description={
          <span className="flex items-center gap-2">
            <StatusDot />
            Assistants reach PCP at {host}
          </span>
        }
      />

      {servers.length === 0 ? <GetStarted hasToken={live.length > 0} /> : null}

      {pending.total > 0 ? (
        <ListSection
          title={
            <span className="flex items-center gap-2 text-[17px] text-foreground">
              Waiting for you
              <CountBadge count={pending.total} />
            </span>
          }
        >
          <List as="ul" className="ring-1 ring-warning/25">
            {pending.requests.map((request) => (
              <ListRow
                as="li"
                key={request.id}
                className="min-h-[68px]"
                title={request.title}
                description={
                  <>
                    {request.tokenName} ·{" "}
                    <RelativeDate value={request.createdAt} />
                  </>
                }
                trailing={
                  <ButtonLink href={`/permissions/${request.id}`}>
                    Review
                  </ButtonLink>
                }
              />
            ))}
          </List>
          {pending.total > pending.requests.length ? (
            <p className="px-1 text-xs text-muted-foreground">
              {pending.total - pending.requests.length} more, older: each
              assistant&apos;s page lists its own.
            </p>
          ) : null}
        </ListSection>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Assistants</CardTitle>
            <Link href="/tokens" className="text-[13px] text-primary">
              See all
            </Link>
          </div>
          {live.length === 0 ? (
            <CardDescription>
              None yet. Each assistant connects with its own API token.
            </CardDescription>
          ) : (
            <ul className="flex flex-col divide-y divide-separator">
              {live.slice(0, ASSISTANTS_SHOWN).map((token) => (
                <li key={token.id}>
                  <Link
                    href={`/tokens/${token.id}`}
                    className="flex items-center justify-between gap-3 py-2.5 text-foreground hover:text-primary"
                  >
                    <span className="truncate">{token.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <RelativeDate
                        value={token.lastUsedAt}
                        never="Not used yet"
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div>
            <ButtonLink href="/tokens" variant="secondary">
              <Plus aria-hidden />
              Connect an assistant
            </ButtonLink>
          </div>
        </Card>

        <Card>
          <CardTitle>Connection address</CardTitle>
          <CardDescription>
            Add it to an assistant as a remote MCP server, with that
            assistant&apos;s own API token.
          </CardDescription>
          <CopyableValue value={`${publicUrl}/mcp`} />
        </Card>
      </div>

      {servers.length > 0 ? (
        <ListSection
          title={<span className="text-[17px] text-foreground">Servers</span>}
          action={
            <Link href="/servers" className="text-[13px] text-primary">
              See all
            </Link>
          }
        >
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
            {servers.map((server) => (
              <li key={server.id}>
                <Link
                  href={`/servers/${server.id}`}
                  className="flex h-full flex-col gap-3 rounded-xl bg-card p-4 text-foreground transition-colors hover:bg-row-hover"
                >
                  <IconTile kind={server.kind} />
                  <span className="flex flex-col gap-1.5">
                    <span className="font-semibold">{server.name}</span>
                    <span className="sr-only">
                      {serverKindLabel(server.kind)}
                    </span>
                    <ServerStatusBadge
                      status={server.status}
                      connected={server.connected}
                      enabled={server.enabled}
                      kind={server.kind}
                      oauth={server.authType === "oauth"}
                    />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </ListSection>
      ) : null}
    </>
  )
}
