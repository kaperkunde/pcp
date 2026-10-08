import type { ReactNode } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteFooter } from "@/components/site-footer"
import { networkNotices } from "@/lib/core/network/runtime"
import { listPendingRequests } from "@/lib/core/permissions"
import { availableUpdate } from "@/lib/core/updates/state"
import { getVault } from "@/lib/core/vault"
import { PCP_VERSION } from "@/lib/core/version"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/**
 * Every signed-in page: the sidebar (DESIGN.md › Navigation) and the
 * content column beside it, 960px at most; a single thing's page narrows
 * itself with PageColumn.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode
}) {
  const { ctx } = await requireSession()
  const [vault, pending, notices, update] = await Promise.all([
    getVault(ctx.vaultId),
    publicUrlFor(ctx).then((publicUrl) => listPendingRequests(ctx, publicUrl)),
    networkNotices(),
    availableUpdate(),
  ])

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <AppSidebar
        vaultName={vault.name}
        version={PCP_VERSION}
        update={update}
        pending={{
          total: pending.total,
          requests: pending.requests.map((request) => ({
            ...request,
            createdAt: request.createdAt.toISOString(),
          })),
          notices,
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex w-full flex-1 flex-col px-4 py-8 text-sm sm:px-8 md:px-12 md:py-10">
          <div className="mx-auto flex w-full max-w-[960px] flex-col gap-8">
            {children}
          </div>
        </main>
        <SiteFooter />
      </div>
    </div>
  )
}
