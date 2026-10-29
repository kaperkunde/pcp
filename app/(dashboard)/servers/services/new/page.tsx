import type { Metadata } from "next"
import Link from "next/link"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { ServiceLaunchForm } from "@/components/service-form"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { IconTile } from "@/components/ui/icon-tile"
import { db } from "@/lib/core/db"
import { isCommonRepository } from "@/lib/core/repos/common"
import { listRepos } from "@/lib/core/repos/store"
import { listSecrets } from "@/lib/core/secrets"
import {
  exitServiceDefinitions,
  serviceOfDefinition,
} from "@/lib/core/services/services"
import { sshServerView } from "@/lib/core/ssh/hosts"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Launch a service" }

/**
 * Launching a service: from a definition the owner types, or another of a
 * service the vault has (`?definition=<id>`), whose definition is shown and
 * taken as it is. Add a VPN exit (`?exit=1&host=<SSH server>`, from the
 * Exits card) offers the vault's exit definitions and the linked
 * repositories that may hold one (PCP's common items have gluetun).
 */
export default async function NewServicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const query = await searchParams
  const definitionId =
    typeof query.definition === "string" ? query.definition : ""
  const forExit = query.exit === "1"
  const hostId = typeof query.host === "string" ? query.host : ""
  const another = definitionId
    ? await serviceOfDefinition(ctx, definitionId).catch(() => null)
    : null
  const hosts = (
    await db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId, kind: "ssh" },
      orderBy: { name: "asc" },
    })
  )
    // A service's commands go only to a server whose host key is pinned.
    .filter((server) => server.sshHostKey)
    .map((server) => ({
      id: server.id,
      name: server.name,
      address: sshServerView(server).host,
    }))
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))
  const exitDefinitions =
    forExit && !another ? await exitServiceDefinitions(ctx) : []
  const repos = forExit && !another ? await listRepos(ctx) : []
  const more = (definition: string) =>
    `/servers/services/new?${new URLSearchParams({
      definition,
      exit: "1",
      ...(hostId ? { host: hostId } : {}),
    })}`

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind="service" size="lg" />}
        title={
          another
            ? `Launch another ${another.name}`
            : forExit
              ? "Add a VPN exit"
              : "Launch a service"
        }
        description={
          forExit
            ? "PCP runs a VPN client in a container on one of your SSH servers with the Docker or Podman already there, and adds its proxy as an exit in the same step: web fetch and the browser can then go out through the VPN, for the tokens you allow. Its credentials come from your vault; assistants never see them."
            : "PCP runs a container on one of your SSH servers with the Docker or Podman already there, and adds what it serves as an API endpoint or MCP server in the same step. Its secrets come from your vault; assistants never see them."
        }
      />
      {forExit && !another ? (
        <Card className="items-start gap-3 p-5 text-sm leading-relaxed sm:p-6">
          <p className="font-medium">Start from a VPN client you trust</p>
          {exitDefinitions.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {exitDefinitions.map((entry) => (
                <li key={entry.definitionId}>
                  <Link
                    href={more(entry.definitionId)}
                    className="underline underline-offset-2"
                  >
                    Another {entry.name}
                  </Link>{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    {entry.image}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-muted-foreground">
            PCP&apos;s common items have{" "}
            <strong className="text-foreground">Gluetun</strong>, a VPN client
            for most providers (OpenVPN or WireGuard) and for a WireGuard server
            of your own, pinned by digest: launch it from the repository, where
            you read it whole first.
          </p>
          <div className="flex flex-wrap gap-2">
            {repos.map((repo) => (
              <ButtonLink
                key={repo.id}
                href={`/settings/repositories/${repo.id}/browse`}
                variant="secondary"
                size="sm"
              >
                {isCommonRepository(repo)
                  ? "Browse PCP's common items"
                  : `Browse ${repo.owner}/${repo.name}`}
              </ButtonLink>
            ))}
            {repos.some(isCommonRepository) ? null : (
              <ButtonLink
                href="/settings/repositories"
                variant="secondary"
                size="sm"
              >
                Add PCP&apos;s common items
              </ButtonLink>
            )}
          </div>
          <p className="text-muted-foreground">
            Or write its definition below: what PCP adds is an exit (registers
            kind exit), its proxy published on the SSH server&apos;s 127.0.0.1
            only.
          </p>
        </Card>
      ) : null}
      {hosts.length > 0 ? (
        <ServiceLaunchForm
          hosts={hosts}
          secrets={secrets}
          defaultHostId={hostId}
          startFromExit={forExit}
          {...(another
            ? {
                fixed: {
                  definition: JSON.stringify(another.definition, null, 2),
                  definitionId,
                  name: another.name.replace(/ service$/i, ""),
                  description: another.description,
                },
              }
            : {})}
        />
      ) : (
        <Card className="items-start gap-3 p-5 text-sm leading-relaxed sm:p-6">
          <p>
            A service runs on one of your SSH servers. Add one first, and check
            its sign-in so PCP pins its host key.
          </p>
          <ButtonLink href="/servers/ssh/new">Add an SSH server</ButtonLink>
        </Card>
      )}
    </PageColumn>
  )
}
