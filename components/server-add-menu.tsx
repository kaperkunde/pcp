"use client"

import { Plus } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { IconTile } from "@/components/ui/icon-tile"
import {
  Menu,
  MenuContent,
  MenuLinkItem,
  MenuNote,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import type { ServerKind } from "@/lib/core/servers"

const CHOICES: Array<{
  kind: ServerKind
  href: string
  title: string
  caption: string
}> = [
  {
    kind: "mcp",
    href: "/servers/new",
    title: "MCP server",
    caption: "By its address",
  },
  {
    kind: "openapi",
    href: "/servers/endpoints/new",
    title: "API endpoint",
    caption: "From an OpenAPI schema",
  },
  {
    kind: "jmap",
    href: "/servers/mail/new",
    title: "Mail account",
    caption: "JMAP, or IMAP with SMTP",
  },
  {
    kind: "ssh",
    href: "/servers/ssh/new",
    title: "SSH server",
    caption: "Run commands on a machine of yours",
  },
  {
    kind: "wrapper",
    href: "/servers/wrappers/new",
    title: "Wrapper",
    caption: "Simpler tools built on your other tools",
  },
  {
    kind: "browser",
    href: "/browser",
    title: "Browser",
    caption: "Opens pages for assistants on this machine",
  },
]

/**
 * Servers' one primary action: a menu of every kind PCP can add, each
 * leading to its own page, and the reminder that an assistant can do the
 * adding. The browser is offered only until it is added: there is one.
 */
export function ServerAddMenu({ hasBrowser }: { hasBrowser: boolean }) {
  return (
    <Menu>
      <MenuTrigger className={buttonVariants()}>
        <Plus aria-hidden strokeWidth={2.2} />
        Add
      </MenuTrigger>
      <MenuContent>
        {CHOICES.filter(
          (choice) => !(hasBrowser && choice.kind === "browser"),
        ).map((choice) => (
          <MenuLinkItem key={choice.href} href={choice.href}>
            <IconTile kind={choice.kind} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[15px] leading-snug">{choice.title}</span>
              <span className="text-xs text-muted-foreground">
                {choice.caption}
              </span>
            </span>
          </MenuLinkItem>
        ))}
        <MenuSeparator />
        <MenuNote>
          Or ask an assistant:{" "}
          <q className="text-foreground">Have PCP add my Gmail.</q> You see the
          address and tools before anything is added.
        </MenuNote>
      </MenuContent>
    </Menu>
  )
}
