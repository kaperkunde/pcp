"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import {
  browserOverview,
  closeOwnerTab,
  forgetSites,
  handBackTab,
  openOwnerTab,
  ownerBack,
  ownerNavigate,
  ownerReload,
  stopBrowser,
  takeOverTab,
  type BrowserOverview,
} from "@/lib/core/browser/owner"
import {
  createBrowserServer,
  updateBrowserServer,
} from "@/lib/core/browser/server"
import { isPcpError } from "@/lib/core/errors"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

/**
 * What the owner does with the browser on its pages: add it, open and
 * close tabs, take one over and hand it back, move it along while it is
 * theirs, close the browser, forget its sign-ins.
 */

function revalidateBrowser() {
  revalidatePath("/browser", "layout")
  revalidatePath("/servers")
}

export async function enableBrowserAction(): Promise<ActionState> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await createBrowserServer(ctx)
    return {}
  })
  revalidateBrowser()
  return result
}

export async function updateBrowserAction(
  _previous: ActionState<{ message: string }>,
  formData: FormData,
): Promise<ActionState<{ message: string }>> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await updateBrowserServer(ctx, {
      name: field(formData, "name"),
      description: field(formData, "description"),
    })
    return { message: "Saved." }
  })
  revalidateBrowser()
  return result
}

export async function openTabAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await requireContext()
  let opened: string | null = null

  const result = await guarded(async () => {
    const tab = await openOwnerTab(ctx, {
      url: field(formData, "url"),
      publicUrl: await publicUrlFor(ctx),
    })
    opened = tab.id
    return {}
  })

  revalidateBrowser()

  if (opened) {
    redirect(`/browser/tabs/${opened}`)
  }

  return result
}

/** A tab's buttons: each one thing to the tab, answered with an ActionState. */
async function onTab(run: () => Promise<void>): Promise<ActionState> {
  const result = await guarded(async () => {
    await run()
    return {}
  })
  revalidateBrowser()
  return result
}

export async function takeOverTabAction(tabId: string): Promise<ActionState> {
  const ctx = await requireContext()
  return onTab(() => takeOverTab(ctx, tabId))
}

export async function handBackTabAction(tabId: string): Promise<ActionState> {
  const ctx = await requireContext()
  return onTab(() => handBackTab(ctx, tabId))
}

export async function closeTabAction(tabId: string): Promise<ActionState> {
  const ctx = await requireContext()
  return onTab(() => closeOwnerTab(ctx, tabId))
}

export async function navigateTabAction(
  tabId: string,
  url: string,
): Promise<ActionState> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)
  return onTab(() => ownerNavigate(ctx, tabId, { url, publicUrl }))
}

export async function backTabAction(tabId: string): Promise<ActionState> {
  const ctx = await requireContext()
  return onTab(() => ownerBack(ctx, tabId))
}

export async function reloadTabAction(tabId: string): Promise<ActionState> {
  const ctx = await requireContext()
  return onTab(() => ownerReload(ctx, tabId))
}

export async function closeBrowserAction(): Promise<ActionState> {
  const ctx = await requireContext()
  return onTab(() => stopBrowser(ctx))
}

export async function forgetSitesAction(): Promise<ActionState> {
  const ctx = await requireContext()
  return onTab(() => forgetSites(ctx))
}

/** The Browser page's live part, polled while it is open. */
export async function browserOverviewAction(): Promise<BrowserOverview | null> {
  const ctx = await requireContext()

  try {
    return await browserOverview(ctx)
  } catch (error) {
    if (isPcpError(error)) return null
    throw error
  }
}
