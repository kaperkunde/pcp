import type { Metadata } from "next"

import { CloneForm, type CloneSource } from "@/components/clone-form"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { RepoFilesReview } from "@/components/repo-review"
import { ServiceLaunchForm } from "@/components/service-form"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { importItemAction, importServiceAction } from "@/lib/actions/repos"
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
} from "@/lib/core/constants"
import { db } from "@/lib/core/db"
import { isPcpError } from "@/lib/core/errors"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import type {
  EndpointDocument,
  ServerDocument,
} from "@/lib/core/repos/documents"
import { commitAt } from "@/lib/core/repos/github"
import { findLocalItem } from "@/lib/core/repos/local"
import {
  fetchItem,
  listRemote,
  type FetchedItem,
} from "@/lib/core/repos/remote"
import { reviewItem } from "@/lib/core/repos/review"
import { specServerUrls } from "@/lib/core/repos/share-review"
import { clientFor, getRepo } from "@/lib/core/repos/store"
import { listSecrets } from "@/lib/core/secrets"
import { sshServerView } from "@/lib/core/ssh/hosts"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add from a repository" }

export const dynamic = "force-dynamic"

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : ""
}

/** The address an item suggests: a format-1 document's, or its schema's. */
function suggestedUrl(document: EndpointDocument | ServerDocument): string {
  if (document.instance) {
    return document.instance.url
  }

  return document.kind === "endpoint"
    ? (specServerUrls(document.spec.text)[0] ?? "")
    : ""
}

function sourceOf(
  document: EndpointDocument | ServerDocument,
  root: string,
): CloneSource {
  const auth = document.auth

  return {
    id: root.replace(/[^A-Za-z0-9_-]/g, "-"),
    kind: document.kind === "endpoint" ? "openapi" : "mcp",
    name: document.displayName,
    authType: auth.kind,
    authUsername: auth.kind === "basic" ? (auth.username ?? "") : "",
    authHeaderName: auth.kind === "header" ? auth.header : DEFAULT_HEADER_NAME,
    authValueTemplate:
      auth.kind === "header" ? auth.template : DEFAULT_VALUE_TEMPLATE,
    authExtraHeaders:
      auth.kind === "header"
        ? auth.headers.map((header) => ({
            secretId: "",
            headerName: header.header,
            valueTemplate: header.template,
          }))
        : [],
    oauthScope: auth.kind === "oauth" ? (auth.scope ?? "") : "",
  }
}

/**
 * A new MCP server, API endpoint or service from a linked repository: the item in
 * full as it would be added, then what is the owner's own, as cloning asks
 * for it (its name, address, sign-in with a secret of theirs, switches and
 * note). The repository holds the definition only; this server is the first
 * of it in the vault. Added exactly as shown, at the commit chosen.
 */
export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const query = await searchParams
  const commit = one(query.commit)
  const root = one(query.root)
  const back = {
    href: `/settings/repositories/${id}/browse`,
    label: "Choose again",
  }
  let fetched: FetchedItem | null = null
  let failure: string | null = null
  let label = "the repository"

  try {
    const repo = await getRepo(ctx, id)
    label = `${repo.owner}/${repo.name}`
    const gh = await clientFor(ctx, repo)
    const listing = await listRemote(
      gh,
      repo,
      repo.branch,
      await commitAt(gh, repo, commit),
    )
    const remote = listing.items.find((item) => item.root === root)

    if (!remote) {
      failure = `${root || "That"} is not an item at that commit.`
    } else {
      fetched = await fetchItem(gh, repo, remote)

      if (
        fetched.document.kind !== "endpoint" &&
        fetched.document.kind !== "server" &&
        fetched.document.kind !== "service"
      ) {
        failure =
          "Only an MCP server, API endpoint or service is added this way."
      } else if (await findLocalItem(ctx, remote.ref)) {
        failure = `Your vault has ${remote.ref.name} already: add it from the list instead, to update it.`
      }
    }
  } catch (error) {
    if (!isPcpError(error)) {
      throw error
    }

    failure = error.message
  }

  if (fetched && !failure && fetched.document.kind === "service") {
    const service = fetched.document
    const review = reviewItem(null, service)
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
      .map(({ id: secretId, name }) => ({ id: secretId, name }))

    return (
      <PageColumn width="narrow">
        <PageHeader
          back={back}
          title={`Launch ${service.displayName} from ${label}`}
          description="The repository has what this service runs: its image, pinned by digest, its ports, variables, volumes, health check and what PCP adds for it. Where it runs, where it is published and the secret each variable takes are yours: give them below. Nothing runs until you launch it."
        />

        <RepoFilesReview
          flags={review.flags}
          files={review.files}
          whole={Object.entries(fetched.files)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, text]) => ({ path, text }))}
          caption="Its file"
        />

        {hosts.length > 0 ? (
          <ServiceLaunchForm
            hosts={hosts}
            secrets={secrets}
            fixed={{
              definition: JSON.stringify(service.definition, null, 2),
              name: service.displayName,
              description: service.description,
            }}
            action={importServiceAction.bind(null, id, {
              commit,
              root,
              hash: fetched.hash,
            })}
          />
        ) : (
          <Card className="items-start gap-3 p-5 text-sm leading-relaxed sm:p-6">
            <p>
              A service runs on one of your SSH servers. Add one first, and
              check its sign-in so PCP pins its host key.
            </p>
            <ButtonLink href="/servers/ssh/new">Add an SSH server</ButtonLink>
          </Card>
        )}
      </PageColumn>
    )
  }

  const document =
    fetched &&
    (fetched.document.kind === "endpoint" || fetched.document.kind === "server")
      ? fetched.document
      : null

  if (!fetched || !document || failure) {
    return (
      <PageColumn width="narrow">
        <PageHeader back={back} title={`Add from ${label}`} />
        <p className="text-destructive" role="alert">
          {failure ?? "Nothing to add."}
        </p>
      </PageColumn>
    )
  }

  const review = reviewItem(null, document)
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id: secretId, name }) => ({ id: secretId, name }))

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={back}
        title={`Add ${document.displayName} from ${label}`}
        description={
          <>
            The repository has what this{" "}
            {document.kind === "endpoint" ? "API endpoint" : "MCP server"} is,
            to share: its description
            {document.kind === "endpoint" ? ", schema and edits" : ""}. Where
            yours is and how it signs in are yours: give them below.
          </>
        }
      />

      <RepoFilesReview
        flags={review.flags}
        files={review.files}
        whole={Object.entries(fetched.files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, text]) => ({ path, text }))}
        caption="Its files"
      />

      <CloneForm
        source={sourceOf(document, root)}
        secrets={secrets}
        redirectUrl={oauthRedirectUrl(await publicUrlFor(ctx))}
        variant={{
          action: importItemAction.bind(null, id, {
            commit,
            root,
            hash: fetched.hash,
          }),
          submitLabel: "Add it",
          pendingLabel: "Adding…",
          cancelHref: back.href,
          name: document.displayName,
          url: suggestedUrl(document),
          ...(document.kind === "endpoint"
            ? {
                switches: {
                  readOnly: document.instance?.readOnly ?? true,
                  publicOnly: document.instance?.publicOnly ?? false,
                },
              }
            : {}),
        }}
      />
    </PageColumn>
  )
}
