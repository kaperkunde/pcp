import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { SignInConsent } from "@/components/sign-in-consent"
import { Card, CardContent } from "@/components/ui/card"
import {
  checkAuthorizationRequest,
  consentQuery,
  errorGoesBack,
  tokensForClient,
} from "@/lib/core/oauth-server/authorize"
import { listServers } from "@/lib/core/servers"
import { getVault, isSetUp } from "@/lib/core/vault"
import { publicUrlFor } from "@/lib/server/public-url"
import { currentSession } from "@/lib/server/session"

/**
 * The authorization endpoint of PCP's own OAuth server: an assistant (Claude,
 * ChatGPT, …) sends the owner here to let it connect to /mcp. The owner
 * signs in first if they are not, sees which app asks and where it sends
 * them back to, chooses what its token may reach, and confirms with their
 * password or Touch ID. See lib/core/oauth-server/.
 */

export const metadata: Metadata = { title: "Connect an assistant" }
export const dynamic = "force-dynamic"

function Refusal({ message }: { message: string }) {
  return (
    <AuthShell title="This sign-in cannot go ahead">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p>{message}</p>
          <p className="text-sm text-muted-foreground">
            Nothing was sent back to the app. Start connecting it again from the
            app, or{" "}
            <Link href="/tokens" className="text-primary hover:underline">
              make an API token
            </Link>{" "}
            for it instead.
          </p>
        </CardContent>
      </Card>
    </AuthShell>
  )
}

/**
 * An error for an app the owner has not let in before: shown here rather
 * than sent back on its own, since anyone can register an app with any
 * return address. Going back is the owner's click on a plain link.
 */
function ErrorForApp({
  name,
  host,
  returnHost,
  description,
  url,
}: {
  name: string
  host: string
  returnHost: string
  description: string
  url: string
}) {
  return (
    <AuthShell title="This sign-in cannot go ahead">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p>
            {name} ({host}) asked for a sign-in PCP cannot give. {description}
          </p>
          <p className="text-sm text-muted-foreground">
            You have not let this app in before, so PCP did not send you back to
            it on its own. If you started this in the app, go back and it is
            told what went wrong; if you did not, close this page.
          </p>
          <p>
            <a
              href={url}
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              Return to {returnHost}
            </a>
          </p>
        </CardContent>
      </Card>
    </AuthShell>
  )
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const query: Record<string, string> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      return <Refusal message={`The app sent ${key} more than once.`} />
    }

    if (value !== undefined) {
      query[key] = value
    }
  }

  if (!(await isSetUp())) {
    return <Refusal message="PCP is not set up yet." />
  }

  const session = await currentSession()
  const search = new URLSearchParams(query).toString()

  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${search}`)}`)
  }

  const publicUrl = await publicUrlFor(session.ctx)
  const check = await checkAuthorizationRequest(query, publicUrl)

  if (check.kind === "redirect") {
    if (await errorGoesBack(session.ctx, check.client.id)) {
      redirect(check.url)
    }

    return (
      <ErrorForApp
        name={check.client.name}
        host={check.client.host}
        returnHost={check.returnHost}
        description={check.description}
        url={check.url}
      />
    )
  }

  if (check.kind === "show") {
    return <Refusal message={check.message} />
  }

  const { client, redirectUri } = check.request
  const [servers, vault, tokens] = await Promise.all([
    listServers(session.ctx),
    getVault(session.ctx.vaultId),
    tokensForClient(session.ctx, client.id),
  ])

  return (
    <AuthShell
      title={`Connect ${client.name}?`}
      intro={
        <p>
          It asks to use PCP as an assistant: to reach your servers through{" "}
          <code>{`${publicUrl}/mcp`}</code> with a token of its own.
        </p>
      }
    >
      <SignInConsent
        request={consentQuery(query, check.request)}
        client={{
          name: client.name,
          host: client.host,
          fromDocument: client.fromDocument,
          returnHost: new URL(redirectUri).host || redirectUri,
        }}
        tokens={tokens.map((token) => ({
          id: token.id,
          name: token.name,
          createdAt: token.createdAt.toISOString(),
        }))}
        servers={servers.map(({ id, name, kind }) => ({ id, name, kind }))}
        username={vault.name}
      />
    </AuthShell>
  )
}
