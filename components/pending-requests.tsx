"use client"

import { Menu } from "@base-ui/react/menu"
import { Bell } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"

import {
  pendingRequestsAction,
  type PendingRequestsState,
} from "@/lib/actions/permissions"
import { cn } from "@/lib/utils"

/** How often the count is read again while the page is in view. */
const REFRESH_MS = 15_000

/** "3 min ago", from the reader's clock. */
function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)

  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)

  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/**
 * The header's bell: how many requests from assistants are waiting for the
 * owner, and a list of them that leads to each one's page. Above them, what
 * PCP itself needs looked at (HTTPS that stopped renewing). The layout gives
 * the first count; it is read again on every navigation, when the menu
 * opens, when the tab comes back into view, and every little while.
 */
export function PendingRequests({
  initial,
}: {
  initial: PendingRequestsState
}) {
  const [state, setState] = useState(initial)
  const pathname = usePathname()

  const refresh = useCallback(async () => {
    try {
      setState(await pendingRequestsAction())
    } catch {
      // Keep what is shown; the next read tries again.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [pathname, refresh])

  useEffect(() => {
    const visible = () => document.visibilityState === "visible"
    const timer = setInterval(() => {
      if (visible()) void refresh()
    }, REFRESH_MS)
    const onVisible = () => {
      if (visible()) void refresh()
    }

    document.addEventListener("visibilitychange", onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  const { total, requests, notices } = state
  const count = total + notices.length
  const label =
    notices.length > 0
      ? `${count} waiting for you`
      : total === 0
        ? "Requests from assistants: none waiting"
        : `Requests from assistants: ${total} waiting for you`

  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) void refresh()
      }}
    >
      <Menu.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "relative inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-foreground/5 data-popup-open:text-foreground",
          count > 0 && "border-primary/50 text-primary",
        )}
      >
        <Bell className="size-4" aria-hidden />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-1.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-destructive px-1 text-[0.7rem] leading-none font-semibold text-background"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="z-50 outline-none"
          sideOffset={8}
          align="end"
        >
          <Menu.Popup className="w-80 max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {notices.map((notice) => (
              <Menu.LinkItem
                key={notice.id}
                closeOnClick
                render={<Link href={notice.href} />}
                className="flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 outline-none data-highlighted:bg-foreground/5"
              >
                <span className="font-medium text-destructive">
                  {notice.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  Open Settings to see why
                </span>
              </Menu.LinkItem>
            ))}
            <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              {total === 0
                ? notices.length > 0
                  ? "No requests from assistants."
                  : "Nothing is waiting for you."
                : `Waiting for you (${total})`}
            </div>
            {total === 0 && notices.length === 0 ? (
              <p className="px-3 pb-2 text-xs text-muted-foreground">
                When an assistant asks before it runs a tool, adds a server or
                shares a memory, it shows here.
              </p>
            ) : null}
            {requests.map((request) => (
              <Menu.LinkItem
                key={request.id}
                closeOnClick
                render={<Link href={`/permissions/${request.id}`} />}
                className="flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 outline-none data-highlighted:bg-foreground/5"
              >
                <span className="font-medium text-foreground">
                  {request.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {request.tokenName} · {ago(request.createdAt)}
                </span>
              </Menu.LinkItem>
            ))}
            {total > requests.length ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {total - requests.length} more, older. Answer these first, or
                find them on each token&apos;s page.
              </p>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
