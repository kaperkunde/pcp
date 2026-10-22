import type { Metadata } from "next"

import { BrowserManager } from "@/components/browser-manager"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { IconTile } from "@/components/ui/icon-tile"
import { browserOverview, browserTokens } from "@/lib/core/browser/owner"
import { findBrowserServer } from "@/lib/core/browser/server"
import { isDesktopApp } from "@/lib/server/desktop"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Browser" }

export const dynamic = "force-dynamic"

/**
 * The browser's own page: every open tab in one view (`?tab=<id>` shows
 * that one live, to watch or take over, and is where a tab's links and its
 * hand-overs lead), the sign-ins it keeps and Chromium. Its tools and
 * levels are on its server page, as any server's are. Once the browser is
 * added and enabled it has an item in the sidebar; until then the page sits
 * under Servers, where it is added from.
 */
export default async function BrowserPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const ctx = await requireContext()
  const { tab } = await searchParams
  const [overview, server, tokens] = await Promise.all([
    browserOverview(ctx),
    findBrowserServer(ctx),
    browserTokens(ctx),
  ])

  return (
    <PageColumn>
      <PageHeader
        back={
          server?.enabled ? undefined : { href: "/servers", label: "Servers" }
        }
        icon={<IconTile kind="browser" size="lg" />}
        title="Browser"
        description="A web browser on the machine PCP runs on, for assistants to open pages with, keeping its sign-ins between conversations. Watch any tab live, and take it over when something needs you: a sign-in, a CAPTCHA, a payment."
      />
      <BrowserManager
        initial={overview}
        selected={typeof tab === "string" && tab !== "" ? tab : null}
        tokens={tokens}
        serverDescription={server?.description ?? ""}
        desktop={isDesktopApp()}
      />
    </PageColumn>
  )
}
