import type { Metadata } from "next"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth-shell"
import { LoginForm } from "@/components/login-form"
import { isSetUp, ownerVault } from "@/lib/core/vault"
import { returnPath } from "@/lib/server/return-path"
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

  const query = await searchParams
  // Where to go on once signed in: an assistant's sign-in, if that sent
  // the owner here.
  const next = returnPath(query.next)

  if (await currentSession()) {
    redirect(next ?? "/home")
  }

  const vault = await ownerVault()
  const restored = query.restored === "1"

  return (
    <AuthShell
      title={vault ? `Hello, ${vault.name}` : "Sign in"}
      intro={
        restored ? (
          <p>
            Restored. Sign in with the password of the PCP the export came from.
          </p>
        ) : next ? (
          <p>
            An assistant wants to connect to PCP. Unlock the vault to see what
            it asks for.
          </p>
        ) : (
          <p>Enter your password to unlock the vault.</p>
        )
      }
    >
      <LoginForm username={vault?.name ?? ""} restored={restored} next={next} />
    </AuthShell>
  )
}
