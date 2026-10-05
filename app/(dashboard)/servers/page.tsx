import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { ServerList } from "@/components/server-list"
import { ButtonLink } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { listApiTokens } from "@/lib/core/api-tokens"
import { isMailKind, listServers } from "@/lib/core/servers"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Servers" }

export default async function ServersPage() {
  const ctx = await requireContext()
  const [all, tokens] = await Promise.all([
    listServers(ctx),
    listApiTokens(ctx),
  ])
  const servers = all.filter((server) => server.kind === "mcp")
  const endpoints = all.filter((server) => server.kind === "openapi")
  const mail = all.filter((server) => isMailKind(server.kind))
  const browser = all.filter((server) => server.kind === "browser")
  const now = new Date()
  const hasToken = tokens.some(
    (token) => !token.revokedAt && (!token.expiresAt || token.expiresAt > now),
  )

  return (
    <>
      <PageHeader
        title="Servers"
        description="What an assistant can reach through PCP: MCP servers, APIs described by an OpenAPI schema, mail accounts, and a browser on this machine. Each is described here in your words; that description is what the assistant reads when it searches for a tool."
      />

      {all.length === 0 ? <LetAnAssistantAddThem hasToken={hasToken} /> : null}

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">MCP servers</h2>
          <ButtonLink href="/servers/new">Add a server</ButtonLink>
        </div>
        <ServerList
          servers={servers}
          empty="No servers yet. Add one, then create an API token so an assistant can use it."
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">API endpoints</h2>
          <ButtonLink href="/servers/endpoints/new">Add an endpoint</ButtonLink>
        </div>
        <ServerList
          servers={endpoints}
          empty="No API endpoints yet. Add one from an OpenAPI schema and its operations become tools an assistant can call."
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">Mail accounts</h2>
          <ButtonLink href="/servers/mail/new">Add a mail account</ButtonLink>
        </div>
        <ServerList
          servers={mail}
          empty="No mail accounts yet. Add one over JMAP or IMAP, and an assistant can search, read and file its mail, and send from it unless you make it read-only."
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg">Browser</h2>
          <ButtonLink href="/browser" variant="outline">
            {browser.length > 0 ? "Tabs and sign-ins" : "Add the browser"}
          </ButtonLink>
        </div>
        <ServerList
          servers={browser}
          empty="No browser yet. Add it on the Browser page, and an assistant can open pages on this machine, while you decide which sites and can take any tab over."
        />
      </section>
    </>
  )
}

/**
 * Before there is anything here: an assistant can do the adding. It finds
 * the server or the API's schema and proposes it with register_server, and
 * nothing exists until the owner agrees, so all it needs is a token.
 */
function LetAnAssistantAddThem({ hasToken }: { hasToken: boolean }) {
  return (
    <Card data-testid="servers-start">
      <CardHeader>
        <CardTitle>Let an assistant set them up</CardTitle>
        <CardDescription>
          You do not have to add servers and endpoints by hand. Connect an
          assistant to PCP with an API token, then ask it, for example:
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          <li>
            <q className="font-medium">Have PCP add my Gmail</q>
          </li>
          <li>
            <q className="font-medium">Have PCP add the Porkbun API</q>
          </li>
        </ul>
        <p className="text-muted-foreground">
          It finds the server, or the API&apos;s schema, and asks you first: you
          see the address and the tools, and nothing is added until you agree. A
          password or key it needs, you type in on PCP&apos;s own page, never in
          the chat.
        </p>
        <div>
          <ButtonLink href="/tokens">
            {hasToken ? "Open your API tokens" : "Create your first API token"}
          </ButtonLink>
        </div>
      </CardContent>
    </Card>
  )
}
