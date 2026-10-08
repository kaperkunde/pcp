import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AuthLink } from "@/components/auth-link"
import { AuthShell } from "@/components/auth-shell"
import { RestoreCard } from "@/components/backup-cards"
import { isSetUp } from "@/lib/core/vault"
import { currentSession } from "@/lib/server/session"

export const metadata: Metadata = { title: "Restore an export" }
export const dynamic = "force-dynamic"

/**
 * The other way to start a PCP: with an export of another one, in place of
 * setting up. Part of the setup flow, and gone once there is an owner (a
 * signed-in owner restores under Settings).
 */
export default async function SetupRestorePage() {
  if (await isSetUp()) {
    redirect((await currentSession()) ? "/settings" : "/login")
  }

  return (
    <AuthShell
      title="Restore an export"
      intro={
        <p>
          You need the file another PCP exported and its export password. The
          vault inside it stays locked with that PCP&apos;s password, which is
          what you sign in with afterwards.
        </p>
      }
    >
      <RestoreCard mode="setup" username="" />
      <AuthLink href="/setup" prompt="Starting fresh?">
        Set up a new PCP
      </AuthLink>
    </AuthShell>
  )
}
