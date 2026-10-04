import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { RestoreInsteadLink } from "@/components/backup-cards"
import { SetupForm } from "@/components/setup-form"
import { isSetUp } from "@/lib/core/vault"
import { currentSession } from "@/lib/server/session"

export const metadata: Metadata = { title: "Set up" }
export const dynamic = "force-dynamic"

export default async function SetupPage() {
  const alreadySetUp = await isSetUp()

  // Setting the session cookie in the setup action re-renders this page,
  // so the owner who just set up must not be bounced away before they
  // have read their recovery key: only strangers are sent to sign in.
  if (alreadySetUp && !(await currentSession())) {
    redirect("/login")
  }

  return (
    <AuthShell
      title="Welcome to PCP"
      intro={
        <p>
          Choose the password that will lock your vault. Everything PCP keeps —
          secrets, connections, tokens — is encrypted with a key only your
          password can unlock, so the server itself cannot read it.
        </p>
      }
    >
      <SetupForm alreadySetUp={alreadySetUp} />
      {alreadySetUp ? null : <RestoreInsteadLink />}
    </AuthShell>
  )
}
