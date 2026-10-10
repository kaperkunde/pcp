import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A page's column inside the dashboard: `wide` for lists and Home (960px),
 * `narrow` for a single thing's page and Settings (820px). The sections in
 * it stand 32px apart. DESIGN.md › Pages.
 */
export function PageColumn({
  width = "wide",
  className,
  children,
}: {
  width?: "wide" | "narrow"
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-8",
        width === "narrow" && "max-w-[820px]",
        className,
      )}
    >
      {children}
    </div>
  )
}
