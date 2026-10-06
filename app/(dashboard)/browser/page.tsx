import type { Metadata } from "next"

import { BrowserManager } from "@/components/browser-manager"
import { PageHeader } from "@/components/page-header"
import { browserOverview } from "@/lib/core/browser/owner"
import { findBrowserServer } from "@/lib/core/browser/server"
import { isDesktopApp } from "@/lib/server/desktop"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Browser" }

export const dynamic = "force-dynamic"

export default async function BrowserPage() {
  const ctx = await requireContext()
  const [overview, server] = await Promise.all([
    browserOverview(ctx),
    findBrowserServer(ctx),
  ])

  return (
    <>
      <PageHeader
        title="Browser"
        description="A web browser on the machine PCP runs on, for assistants to open pages with, keeping its sign-ins between conversations. Watch any tab live, and take it over when something needs you: a sign-in, a CAPTCHA, a payment."
      />
      <BrowserManager
        initial={overview}
        serverDescription={server?.description ?? ""}
        desktop={isDesktopApp()}
      />
    </>
  )
}
