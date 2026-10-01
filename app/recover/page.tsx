import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { RecoverForm } from "@/components/recover-form"
import { isSetUp } from "@/lib/core/vault"

export const metadata: Metadata = { title: "Recover" }
export const dynamic = "force-dynamic"

export default async function RecoverPage() {
  if (!(await isSetUp())) {
    redirect("/setup")
  }

  return (
    <AuthShell
      title="Recover access"
      intro={
        <p>
          The recovery key from setup unlocks the vault without the password.
          Setting a new password signs every browser out. API tokens keep
          working unless you revoke them here too.
        </p>
      }
    >
      <RecoverForm />
    </AuthShell>
  )
}
