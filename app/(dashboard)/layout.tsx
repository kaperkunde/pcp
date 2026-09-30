import Link from "next/link"
import type { ReactNode } from "react"

import { DashboardNav } from "@/components/dashboard-nav"
import { PcpMark } from "@/components/pcp-mark"
import { Button } from "@/components/ui/button"
import { logoutAction } from "@/lib/actions/auth"
import { getVault } from "@/lib/core/vault"
import { requireSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}) {
  const { ctx } = await requireSession()
  const vault = await getVault(ctx.vaultId)

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/servers" className="flex items-center gap-3">
          <PcpMark />
          <span className="text-lg font-medium">PCP</span>
        </Link>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>{vault.name}</span>
          <form action={logoutAction}>
            <Button type="submit" variant="outline" size="sm">
              Lock
            </Button>
          </form>
        </div>
      </header>
      <DashboardNav />
      <section className="flex flex-col gap-6 text-sm">{children}</section>
    </main>
  )
}
