import {
  Braces,
  Globe,
  Layers,
  Mail,
  Server,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react"

import type { ServerKind } from "@/lib/core/servers"
import { cn } from "@/lib/utils"

const KINDS: Record<
  ServerKind,
  { icon: LucideIcon; className: string; label: string }
> = {
  mcp: {
    icon: Server,
    className: "bg-tile-mcp text-tile-mcp-foreground",
    label: "MCP server",
  },
  openapi: {
    icon: Braces,
    className: "bg-tile-api text-tile-api-foreground",
    label: "API endpoint",
  },
  jmap: {
    icon: Mail,
    className: "bg-tile-mail text-tile-mail-foreground",
    label: "Mail account",
  },
  imap: {
    icon: Mail,
    className: "bg-tile-mail text-tile-mail-foreground",
    label: "Mail account",
  },
  browser: {
    icon: Globe,
    className: "bg-tile-browser text-tile-browser-foreground",
    label: "Browser",
  },
  ssh: {
    icon: SquareTerminal,
    className: "bg-tile-ssh text-tile-ssh-foreground",
    label: "SSH server",
  },
  wrapper: {
    icon: Layers,
    className: "bg-tile-wrapper text-tile-wrapper-foreground",
    label: "Wrapper",
  },
}

/** What a kind of server is called in the UI ("API endpoint"). */
export function serverKindLabel(kind: ServerKind): string {
  return KINDS[kind].label
}

const SIZES = {
  sm: "size-[30px] rounded-lg [&_svg]:size-4",
  md: "size-[34px] rounded-[9px] [&_svg]:size-[18px]",
  lg: "size-14 rounded-[14px] [&_svg]:size-7",
}

/**
 * The rounded square before a row or a page title. A server's kind picks its
 * tint and symbol, so the kinds tell apart at a glance; anything else passes
 * its own `icon` and a neutral tile. Decorative: the text beside it names it.
 */
export function IconTile({
  kind,
  icon: Icon,
  size = "md",
  className,
}: {
  kind?: ServerKind
  icon?: LucideIcon
  size?: keyof typeof SIZES
  className?: string
}) {
  const known = kind ? KINDS[kind] : null
  const Symbol = Icon ?? known?.icon ?? Server

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        SIZES[size],
        known?.className ?? "bg-secondary text-foreground",
        className,
      )}
    >
      <Symbol strokeWidth={1.8} />
    </span>
  )
}
