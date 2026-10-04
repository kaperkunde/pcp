import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { LoginForm } from "@/components/login-form"
import { isSetUp, ownerVault } from "@/lib/core/vault"
import { currentSession } from "@/lib/server/session"

export const metadata: Metadata = { title: "Sign in" }
export const dynamic = "force-dynamic"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (!(await isSetUp())) {
    redirect("/setup")
  }

  if (await currentSession()) {
    redirect("/servers")
  }

  const vault = await ownerVault()
  const restored = (await searchParams).restored === "1"

  return (
    <AuthShell
      title={vault ? `Hello, ${vault.name}` : "Sign in"}
      intro={
        restored ? (
          <p>
            Restored. Sign in with the password of the PCP the export came from.
          </p>
        ) : (
          <p>Enter your password to unlock the vault.</p>
        )
      }
    >
      <LoginForm username={vault?.name ?? ""} />
    </AuthShell>
  )
}
