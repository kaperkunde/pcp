import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A short label beside a name: a state ("Read-only"), a hint ("Changes
 * data") or a count. `solid-warning` is for what needs the owner now
 * ("Sign in again"); everything else stays quiet.
 */
const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 rounded-md border border-transparent px-1.5 text-[11px] font-semibold whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-foreground",
        secondary: "bg-muted text-muted-foreground",
        destructive: "bg-destructive/15 text-destructive",
        warning: "bg-warning/15 text-warning",
        "solid-warning": "bg-warning text-warning-foreground",
        outline: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

/** A count beside a navigation item or a heading: what waits for you. */
function CountBadge({
  count,
  className,
}: {
  count: number
  className?: string
}) {
  if (count <= 0) {
    return null
  }

  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-xs leading-none font-bold text-warning-foreground",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

/** The dot before a status: teal when fine, amber when it needs you. */
function StatusDot({
  tone = "ok",
  className,
}: {
  tone?: "ok" | "warning" | "error" | "off"
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-primary",
        tone === "warning" && "bg-warning",
        tone === "error" && "bg-destructive",
        tone === "off" && "bg-muted-foreground/50",
        className,
      )}
    />
  )
}

export { Badge, badgeVariants, CountBadge, StatusDot }
