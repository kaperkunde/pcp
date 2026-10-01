import Link from "next/link"
import type { ReactNode } from "react"

import { DashboardNav } from "@/components/dashboard-nav"
import { PcpMark } from "@/components/pcp-mark"
import { PendingRequests } from "@/components/pending-requests"
import { Button } from "@/components/ui/button"
import { logoutAction } from "@/lib/actions/auth"
import { listPendingRequests } from "@/lib/core/permissions"
import { getVault } from "@/lib/core/vault"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}) {
  const { ctx } = await requireSession()
  const [vault, pending] = await Promise.all([
    getVault(ctx.vaultId),
    publicUrlFor(ctx).then((publicUrl) => listPendingRequests(ctx, publicUrl)),
  ])

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Link href="/servers" className="flex items-center gap-3">
          <PcpMark />
          <span className="text-lg font-medium">PCP</span>
        </Link>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <PendingRequests
            initial={{
              total: pending.total,
              requests: pending.requests.map((request) => ({
                ...request,
                createdAt: request.createdAt.toISOString(),
              })),
            }}
          />
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
