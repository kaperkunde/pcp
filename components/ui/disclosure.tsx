import { ChevronDown } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * What is set once and rarely looked at again, folded under one row: the
 * title, a grey line naming what is inside, a chevron. Native
 * <details>/<summary>, so it opens without script and keeps its content in
 * the page (forms inside it still submit). DESIGN.md › Advanced.
 *
 * Alone it is its own rounded panel; `inList` drops the panel to sit as a
 * row of a List.
 */
function Disclosure({
  title,
  description,
  icon,
  defaultOpen,
  inList = false,
  className,
  contentClassName,
  children,
  ...props
}: Omit<React.ComponentProps<"details">, "title" | "open"> & {
  title: React.ReactNode
  description?: React.ReactNode
  icon?: React.ReactNode
  defaultOpen?: boolean
  inList?: boolean
  contentClassName?: string
}) {
  return (
    <details
      data-slot="disclosure"
      open={defaultOpen}
      className={cn(
        "group/disclosure",
        !inList && "overflow-hidden rounded-xl bg-card",
        className,
      )}
      {...props}
    >
      <summary className="flex min-h-14 cursor-pointer items-center gap-3.5 px-4 py-2.5 text-sm outline-none select-none hover:bg-row-hover focus-visible:bg-row-hover">
        {icon}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] leading-snug text-foreground">
            {title}
          </span>
          {description ? (
            <span className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-180"
        />
      </summary>
      <div
        className={cn(
          "flex flex-col gap-4 border-t border-separator px-4 py-4",
          contentClassName,
        )}
      >
        {children}
      </div>
    </details>
  )
}

export { Disclosure }
