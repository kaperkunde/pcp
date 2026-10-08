"use client"

import { Bell } from "lucide-react"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"

import {
  Menu,
  MenuContent,
  MenuLinkItem,
  MenuNote,
  MenuTrigger,
} from "@/components/ui/menu"
import {
  pendingRequestsAction,
  type PendingRequestsState,
} from "@/lib/actions/permissions"
import { cn, timeAgo } from "@/lib/utils"

/** How often the count is read again while the page is in view. */
const REFRESH_MS = 15_000

/**
 * What is waiting for the owner, kept fresh: the layout gives the first
 * count; it is read again on every navigation, when the bell opens, when
 * the tab comes back into view, and every little while. The sidebar shares
 * one copy between the bell and Home's count.
 */
export function usePendingRequests(initial: PendingRequestsState) {
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

  return { state, refresh }
}

/**
 * The bell: how many requests from assistants are waiting for the owner,
 * and a list of them that leads to each one's page. Above them, what PCP
 * itself needs looked at (HTTPS that stopped renewing).
 */
export function PendingRequests({
  state,
  refresh,
}: {
  state: PendingRequestsState
  refresh: () => Promise<void>
}) {
  const { total, requests, notices } = state
  const count = total + notices.length
  const label =
    notices.length > 0
      ? `${count} waiting for you`
      : total === 0
        ? "Requests from assistants: none waiting"
        : `Requests from assistants: ${total} waiting for you`

  return (
    <Menu
      onOpenChange={(open) => {
        if (open) void refresh()
      }}
    >
      <MenuTrigger
        aria-label={label}
        title={label}
        className={cn(
          "relative inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-foreground/5 data-popup-open:text-foreground",
          count > 0 && "text-warning",
        )}
      >
        <Bell className="size-[18px]" aria-hidden />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[0.65rem] leading-none font-bold text-warning-foreground"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuContent align="start">
        {notices.map((notice) => (
          <MenuLinkItem
            key={notice.id}
            href={notice.href}
            className="flex-col items-start gap-0.5"
          >
            <span className="font-medium text-destructive">{notice.title}</span>
            <span className="text-xs text-muted-foreground">
              Open Settings to see why
            </span>
          </MenuLinkItem>
        ))}
        <MenuNote className="pb-1 font-semibold">
          {total === 0
            ? notices.length > 0
              ? "No requests from assistants."
              : "Nothing is waiting for you."
            : `Waiting for you (${total})`}
        </MenuNote>
        {total === 0 && notices.length === 0 ? (
          <MenuNote className="pt-0">
            When an assistant asks before it runs a tool, adds a server, shares
            a memory or opens a site in the browser, or needs you in a browser
            tab, it shows here.
          </MenuNote>
        ) : null}
        {requests.map((request) => (
          <MenuLinkItem
            key={request.id}
            href={`/permissions/${request.id}`}
            className="flex-col items-start gap-0.5"
          >
            <span className="font-medium">{request.title}</span>
            <span className="text-xs text-muted-foreground">
              {request.tokenName} · {timeAgo(request.createdAt)}
            </span>
          </MenuLinkItem>
        ))}
        {total > requests.length ? (
          <MenuNote>
            {total - requests.length} more, older. Answer these first, or find
            them on each token&apos;s page.
          </MenuNote>
        ) : null}
      </MenuContent>
    </Menu>
  )
}
