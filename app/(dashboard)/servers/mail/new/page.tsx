import type { Metadata } from "next"

import {
  EMPTY_MAIL_ACCOUNT,
  MailAccountForm,
} from "@/components/mail-account-form"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { IconTile } from "@/components/ui/icon-tile"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { listSecrets } from "@/lib/core/secrets"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add a mail account" }

export default async function NewMailAccountPage() {
  const ctx = await requireContext()
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind="jmap" size="lg" />}
        title="Add a mail account"
        description="PCP signs in as soon as the account is added and offers an assistant the same mail tools for every account: search, read, file, flag and, unless it is read-only, send. Each call goes straight to your mail server with the secret you choose."
      />
      <MailAccountForm
        initial={EMPTY_MAIL_ACCOUNT}
        secrets={secrets}
        redirectUrl={oauthRedirectUrl(await publicUrlFor(ctx))}
      />
    </PageColumn>
  )
}
