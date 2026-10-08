import type { Metadata } from "next"
import { redirect } from "next/navigation"

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

  return <SetupForm alreadySetUp={alreadySetUp} />
}
