import { redirect } from "next/navigation"

import { requireContext } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/**
 * Where a tab's own page was: the tab is now shown in the Browser page's
 * tabs view, which this sends earlier links on to.
 */
export default async function BrowserTabPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireContext()
  const { id } = await params

  redirect(`/browser?tab=${encodeURIComponent(id)}`)
}
