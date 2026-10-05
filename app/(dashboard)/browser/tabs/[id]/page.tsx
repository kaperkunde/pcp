import type { Metadata } from "next"
import Link from "next/link"

import { BrowserTabView } from "@/components/browser-tab-view"
import { PageHeader } from "@/components/page-header"
import { tabFor } from "@/lib/core/browser/owner"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = {
  title: "Browser tab",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

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
  const tab = await tabFor(ctx, id)

  if (!tab) {
    return (
      <>
        <PageHeader title="Browser tab" />
        <p className="text-muted-foreground" role="alert">
          This tab is closed, or the browser has closed since (it closes after a
          while with nothing to do). The{" "}
          <Link href="/browser" className="underline">
            Browser
          </Link>{" "}
          page lists the open ones.
        </p>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title={tab.title || "Browser tab"}
        description={
          <>
            Opened by {tab.openedBy === "owner" ? "you" : tab.openedBy}.{" "}
            <Link href="/browser" className="underline">
              All tabs
            </Link>
          </>
        }
      />
      <BrowserTabView tabId={tab.id} initial={tab} />
    </>
  )
}
