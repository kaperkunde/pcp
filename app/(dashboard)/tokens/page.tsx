import type { Metadata } from "next"

import { ConnectAssistant } from "@/components/assistant-connect"
import { LocalDate, RelativeDate } from "@/components/local-date"
import { PageHeader } from "@/components/page-header"
import { TokenAvatar } from "@/components/token-avatar"
import { Badge } from "@/components/ui/badge"
import { Card, CardDescription, CardTitle } from "@/components/ui/card"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { listApiTokens, type ApiTokenSummary } from "@/lib/core/api-tokens"
import { listServers } from "@/lib/core/servers"
import { getVault } from "@/lib/core/vault"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Assistants" }

/** How many server names a row shows before it counts the rest. */
const SERVERS_NAMED = 3

/**
 * Every assistant that connects to PCP, each by its own API token: the
 * live ones first, then the ones that no longer work. Connecting a new one
 * is a sheet over this page.
 */
export default async function TokensPage() {
  const ctx = await requireContext()
  const [tokens, servers, vault, publicUrl] = await Promise.all([
    listApiTokens(ctx),
    listServers(ctx),
    getVault(ctx.vaultId),
    publicUrlFor(ctx),
  ])
  const now = new Date()
  const isDead = (token: ApiTokenSummary) =>
    token.revokedAt !== null ||
    (token.expiresAt !== null && token.expiresAt < now)
  const live = tokens.filter((token) => !isDead(token))
  const dead = tokens.filter(isDead)

  return (
    <>
      <PageHeader
        title="Assistants"
        description="Each assistant connects to PCP with an API token of its own, so you can see what each one does and stop it on its own."
        action={
          <ConnectAssistant
            servers={servers.map(({ id, name, kind }) => ({ id, name, kind }))}
            username={vault.name}
            publicUrl={publicUrl}
          />
        }
      />

      {tokens.length === 0 ? (
        <Card>
          <CardTitle>No assistants yet</CardTitle>
          <CardDescription>
            Connect one to give it an API token. It can then find and run your
            servers&apos; tools, asking you the first time it uses each one.
          </CardDescription>
        </Card>
      ) : null}

      {live.length > 0 ? (
        <List as="ul">
          {live.map((token) => (
            <TokenRow key={token.id} token={token} now={now} />
          ))}
        </List>
      ) : null}

      {dead.length > 0 ? (
        <ListSection
          title="Revoked and expired"
          description="These no longer work. Revoking a token destroys its copy of the vault key; nothing it could reach can be read with it again."
        >
          <List as="ul">
            {dead.map((token) => (
              <TokenRow key={token.id} token={token} now={now} />
            ))}
          </List>
        </ListSection>
      ) : null}
    </>
  )
}

function TokenRow({ token, now }: { token: ApiTokenSummary; now: Date }) {
  const expired = token.expiresAt !== null && token.expiresAt < now
  const dead = token.revokedAt !== null || expired
  const features = dead
    ? []
    : [
        token.manageEndpoints ? "Manages endpoints" : null,
        token.keepMemories ? "Keeps memories" : null,
        token.webFetch ? "Fetches the web" : null,
        token.runCode ? "Runs code" : null,
        token.manageWrappers ? "Proposes wrappers" : null,
      ].filter((feature): feature is string => feature !== null)

  return (
    <ListRow
      as="li"
      href={`/tokens/${token.id}`}
      icon={<TokenAvatar name={token.name} dimmed={dead} />}
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium break-words">{token.name}</span>
          {token.revokedAt ? (
            <Badge variant="destructive">Revoked</Badge>
          ) : expired ? (
            <Badge variant="destructive">Expired</Badge>
          ) : token.allowAllServers ? (
            <Badge variant="secondary">All servers</Badge>
          ) : token.servers.length > SERVERS_NAMED ? (
            <Badge variant="secondary">{token.servers.length} servers</Badge>
          ) : token.servers.length === 0 ? (
            <Badge variant="secondary">No servers</Badge>
          ) : (
            token.servers.map((server) => (
              <Badge key={server.id} variant="secondary">
                {server.name}
              </Badge>
            ))
          )}
          {features.map((feature) => (
            <Badge key={feature} variant="secondary">
              {feature}
            </Badge>
          ))}
        </span>
      }
      description={
        <>
          {token.oauthClient ? (
            <>Signed in from {token.oauthClient.name}</>
          ) : (
            <code className="text-xs">{token.prefix}…</code>
          )}
          {" · "}
          {token.lastUsedAt ? (
            <>
              Last used <RelativeDate value={token.lastUsedAt} />
            </>
          ) : (
            "Not used yet"
          )}
          {token.expiresAt && !expired && !token.revokedAt ? (
            <>
              {" · "}Expires <LocalDate value={token.expiresAt} />
            </>
          ) : null}
        </>
      }
      trailing={
        !dead && token.openPermissions > 0 ? (
          <Badge variant="solid-warning">{token.openPermissions} waiting</Badge>
        ) : null
      }
    />
  )
}
