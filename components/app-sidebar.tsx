"use client"

import {
  BookOpen,
  House,
  KeyRound,
  Lock,
  ScrollText,
  Server,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { PcpMark } from "@/components/pcp-mark"
import {
  PendingRequests,
  usePendingRequests,
} from "@/components/pending-requests"
import { CountBadge } from "@/components/ui/badge"
import { UpdateNotice } from "@/components/update-notice"
import { logoutAction } from "@/lib/actions/auth"
import type { PendingRequestsState } from "@/lib/actions/permissions"
import { cn } from "@/lib/utils"

type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Other paths that belong to this item (the browser is a server). */
  also?: string[]
}

/** Where the owner goes every day. DESIGN.md › Navigation. */
const PRIMARY: NavItem[] = [
  { href: "/home", label: "Home", icon: House, also: ["/permissions"] },
  { href: "/servers", label: "Servers", icon: Server, also: ["/browser"] },
  { href: "/tokens", label: "Assistants", icon: UserRound },
  { href: "/memories", label: "Memories", icon: BookOpen },
]

/** What is looked at now and then. */
const SECONDARY: NavItem[] = [
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/log", label: "Log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
]

function isActive(item: NavItem, pathname: string): boolean {
  return [item.href, ...(item.also ?? [])].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  )
}

function NavLink({
  item,
  pathname,
  waiting,
}: {
  item: NavItem
  pathname: string
  waiting: number
}) {
  const active = isActive(item, pathname)
  const Icon = item.icon

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm text-[#c9ced8] transition-colors outline-none hover:bg-[#1e232c] hover:text-white focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-secondary text-white",
      )}
    >
      <Icon aria-hidden className="size-[18px]" strokeWidth={1.8} />
      {item.label}
      {item.href === "/home" ? (
        <CountBadge count={waiting} className="ml-auto" />
      ) : null}
    </Link>
  )
}

/**
 * The dashboard's navigation: a sidebar on a wide window, a bar across the
 * top on a narrow one. The bell and Home's count share one live copy of
 * what is waiting for the owner.
 */
export function AppSidebar({
  vaultName,
  version,
  pending,
  update,
}: {
  vaultName: string
  version: string
  pending: PendingRequestsState
  update: { version: string } | null
}) {
  const pathname = usePathname()
  const { state, refresh } = usePendingRequests(pending)
  const waiting = state.total

  return (
    <aside className="flex shrink-0 flex-col gap-3 border-b border-separator bg-sidebar px-3 py-3 md:sticky md:top-0 md:h-screen md:w-60 md:gap-6 md:overflow-y-auto md:border-r md:border-b-0 md:py-5">
      <div className="flex items-center gap-2 px-1.5">
        <Link
          href="/home"
          aria-label={`PCP v${version}`}
          className="flex min-w-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PcpMark />
          <span className="text-[15px] font-semibold">PCP</span>
          <span className="text-xs text-muted-foreground">v{version}</span>
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <PendingRequests state={state} refresh={refresh} />
          <form action={logoutAction} className="md:hidden">
            <button
              type="submit"
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              <Lock aria-hidden className="size-4" />
              Lock
            </button>
          </form>
        </div>
      </div>

      <nav
        aria-label="Main"
        className="-mx-1 flex gap-0.5 overflow-x-auto px-1 md:mx-0 md:flex-col md:gap-5 md:overflow-visible md:px-0"
      >
        <div className="flex gap-0.5 md:flex-col">
          {PRIMARY.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              waiting={waiting}
            />
          ))}
        </div>
        <div className="flex gap-0.5 md:flex-col">
          {SECONDARY.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              waiting={waiting}
            />
          ))}
        </div>
      </nav>

      <div className="mt-auto hidden flex-col gap-3 md:flex">
        <UpdateNotice available={update} />
        <div className="flex items-center gap-2.5 border-t border-separator px-1.5 pt-3.5">
          <span
            aria-hidden
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-[#2f3642] text-[13px] font-semibold uppercase"
          >
            {vaultName.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {vaultName}
          </span>
          <form action={logoutAction}>
            <button
              type="submit"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-secondary px-2.5 text-[13px] font-medium hover:bg-[#2f3642]"
            >
              <Lock aria-hidden className="size-3.5" />
              Lock
            </button>
          </form>
        </div>
      </div>
    </aside>
  )
}
