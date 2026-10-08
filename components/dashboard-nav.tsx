"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

const TABS = [
  { href: "/servers", label: "Servers" },
  { href: "/secrets", label: "Secrets" },
  { href: "/tokens", label: "API tokens" },
  { href: "/memories", label: "Memories" },
  { href: "/browser", label: "Browser" },
  { href: "/log", label: "Log" },
  { href: "/settings", label: "Settings" },
]

export function DashboardNav() {
  const pathname = usePathname()

  return (
    <nav
      role="tablist"
      className="inline-flex h-9 w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground"
    >
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href)

        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={cn(
              "inline-flex h-7 shrink-0 items-center rounded-md px-3 text-sm font-medium transition-colors hover:text-foreground",
              active && "bg-background text-foreground shadow-sm",
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
