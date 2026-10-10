import type { Metadata } from "next"
import Link from "next/link"

import { BrowserTabView } from "@/components/browser-tab-view"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { Card } from "@/components/ui/card"
import { browserTokens, tabFor } from "@/lib/core/browser/owner"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = {
  title: "Browser tab",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

const BACK = { href: "/browser", label: "Browser" }

/**
 * One browser tab, live: where an assistant's links lead, and where you
 * take a tab over.
 */
export default async function BrowserTabPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const [tab, tokens] = await Promise.all([tabFor(ctx, id), browserTokens(ctx)])

  if (!tab) {
    return (
      <PageColumn width="narrow">
        <PageHeader back={BACK} title="Browser tab" />
        <Card>
          <p className="text-muted-foreground" role="alert">
            This tab is closed, or the browser has closed since (it closes after
            a while with nothing to do). The{" "}
            <Link href="/browser" className="text-primary">
              Browser
            </Link>{" "}
            page lists the open ones.
          </p>
        </Card>
      </PageColumn>
    )
  }

  return (
    <>
      <PageHeader
        back={BACK}
        title={tab.title || "Browser tab"}
        description={`Opened by ${tab.openedBy === "owner" ? "you" : tab.openedBy}.`}
      />
      <BrowserTabView tabId={tab.id} initial={tab} tokens={tokens} />
    </>
  )
}
