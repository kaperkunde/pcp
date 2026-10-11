import type { Metadata } from "next"

import {
  CalendarAccountForm,
  EMPTY_CALENDAR_ACCOUNT,
} from "@/components/calendar-account-form"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { IconTile } from "@/components/ui/icon-tile"
import { oauthRedirectUrl } from "@/lib/core/oauth-client"
import { listSecrets } from "@/lib/core/secrets"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add a calendar account" }

export default async function NewCalendarAccountPage() {
  const ctx = await requireContext()
  const secrets = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map(({ id, name }) => ({ id, name }))

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        icon={<IconTile kind="caldav" size="lg" />}
        title="Add a calendar account"
        description="PCP signs in and finds your calendars and reminder lists as soon as the account is added, and offers an assistant the same tools for every account: what is on when, free time, and, unless it is read-only, adding, moving and changing events and reminders. Each call goes straight to your calendar server with the password you choose."
      />
      <CalendarAccountForm
        initial={EMPTY_CALENDAR_ACCOUNT}
        secrets={secrets}
        redirectUrl={oauthRedirectUrl(await publicUrlFor(ctx))}
      />
    </PageColumn>
  )
}
