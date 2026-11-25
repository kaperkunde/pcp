import type { Metadata } from "next"

import { PageColumn, PageHeader } from "@kaperkunde/ui/page"
import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { GoogleEnd, GoogleForm } from "@/components/google-form"
import { IconTile } from "@/components/ui/icon-tile"
import { googleView } from "@/lib/core/google/account"
import { listSecrets } from "@/lib/core/secrets"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Google" }

export const dynamic = "force-dynamic"

/**
 * Connect Google once: the owner's own Google client, the products they
 * want (Gmail, Calendar, Drive and the rest, each one of Google's own MCP
 * servers), and one sign-in for all of them. Only the owner sets this up.
 */
export default async function GooglePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const query = await searchParams
  const [view, secrets] = await Promise.all([
    googleView(ctx, { publicUrl: await publicUrlFor(ctx) }),
    listSecrets(ctx),
  ])
  const account = view.account
  const error = typeof query.error === "string" ? query.error : ""

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind="mcp" size="lg" />}
        title="Google"
        description={
          account?.status === "connected"
            ? `Connected${account.email ? ` as ${account.email}` : ""}. Each product below is a server of its own.`
            : account?.status === "needs_reconnect"
              ? "Google stopped accepting PCP's sign-in. Connect it again; your servers and their settings stay."
              : "Sign in to Google once, and PCP keeps a server for each Google product you choose."
        }
      />

      {error ? <FormError error={error} /> : null}
      {query.connected ? (
        <FormNote message="Connected to Google. Tell the assistant that asked that it is connected, and it carries on." />
      ) : null}

      <GoogleForm
        clientId={account?.clientId ?? ""}
        clientSecretId={account?.clientSecretId ?? ""}
        secrets={secrets
          .filter((secret) => secret.kind === "text")
          .map(({ id, name }) => ({ id, name }))}
        redirectUrl={view.redirectUrl}
        status={account?.status ?? "none"}
        email={account?.email ?? null}
        products={view.products}
      />

      <GoogleEnd
        exists={account !== null}
        connected={account?.status === "connected"}
      />
    </PageColumn>
  )
}
