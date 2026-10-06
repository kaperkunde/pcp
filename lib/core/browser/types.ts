import type { ToolAccess } from "../constants"

/**
 * What the rest of PCP knows about the browser without loading it: a tab
 * as the pages and the assistant see it, and what a tool hands to the
 * permission flow when the owner is needed.
 */

/** Who drives a tab: assistants, or the owner from PCP's page. */
export type TabControl = "assistant" | "owner"

export type TabView = {
  id: string
  url: string
  title: string
  /** "owner", or the name of the token that opened it. */
  openedBy: string
  /** The owner opened it: it stays theirs, never an assistant's. */
  ownersOwn: boolean
  control: TabControl
  /** Set while the owner holds the tab for an assistant's hand-over. */
  handover: boolean
  lastUsedAt: string
}

/** Opening a page at a site the token's levels ask about. */
export type BrowseAsk = {
  serverId: string
  /** The tab to open it in; null for a new tab. */
  tabId: string | null
  url: string
  /** The tool that asked, for the owner's page and the request's name. */
  toolName: "tabs" | "navigate"
}

/** An assistant asking the owner to do something in a tab themselves. */
export type HandoverAsk = {
  serverId: string
  tabId: string
  message: string
  url: string
  title: string
}

export type BrowserAsk =
  | { kind: "browse"; input: BrowseAsk }
  | { kind: "browser_handover"; input: HandoverAsk }

/**
 * Thrown by a browser tool when the owner has to answer first. The call
 * that ran the tool (permissions.ts runCall) turns it into a permission
 * request, so the browser never imports the permission flow.
 */
export class OwnerNeeded extends Error {
  constructor(readonly ask: BrowserAsk) {
    super("The owner's answer is needed first.")
    this.name = "OwnerNeeded"
  }
}

export function isOwnerNeeded(error: unknown): error is OwnerNeeded {
  return error instanceof OwnerNeeded
}

/** A site's level, as the browser asks for it (GET: reading a page). */
export type BrowseDecision = { access: ToolAccess; host: string }
