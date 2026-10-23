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
  /**
   * The page's icon as a data: address, from what Chromium loaded for the
   * page itself (favicon.ts); null when it has none PCP shows.
   */
  favicon: string | null
  /** "owner", or the name of the token that opened it. */
  openedBy: string
  /**
   * The token whose tab it is: the last one that had it, which Hand back
   * offers first. Null for a tab the owner opened and no token had yet.
   */
  tokenId: string | null
  control: TabControl
  /** Set while the owner holds the tab for an assistant's hand-over. */
  handover: boolean
  /** A tool call is working in it now. */
  busy: boolean
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

/** The type call that carried a secret, as it is made again once allowed. */
export type SecretTypeCall = {
  tab: string
  ref?: string
  target?: Record<string, unknown>
  submit?: boolean
}

/**
 * Typing one of the owner's secrets into a page where the token has no
 * allowance for it (lib/core/browser-secrets.ts): its name, never its
 * value, and the page it would go into.
 */
export type SecretUseAsk = {
  serverId: string
  tabId: string
  secretName: string
  /** https://host[:port] of the page, and of the frame the field is in. */
  origin: string
  url: string
  title: string
  /** The field, as the call named it: its ref, or its role and name. */
  field: string
  call: SecretTypeCall
}

/**
 * An assistant asking the owner to store a secret for the browser to type
 * (request_secret): its name, what it is for and where it goes. The owner
 * types the value in on PCP's page; nothing of it comes back but the name.
 */
export type SecretRequestAsk = {
  serverId: string
  name: string
  purpose: string
  origins: string[]
  kind: "text" | "totp"
}

export type BrowserAsk =
  | { kind: "browse"; input: BrowseAsk }
  | { kind: "browser_handover"; input: HandoverAsk }
  | { kind: "secret_use"; input: SecretUseAsk }
  | { kind: "secret_request"; input: SecretRequestAsk }

/** Where a call types a secret: what upstream.ts is told when it is typed. */
export type SecretUseContext = {
  tabId: string
  origin: string
  url: string
  title: string
  field: string
  call: SecretTypeCall
}

/**
 * A stored secret for a type call to put into a page, handed to the browser
 * by upstream.ts: the browser asks for the value only once the field and
 * its frame checked out, at the moment of typing, for the origin it found
 * then. Whether the token may, and the decryption, are upstream.ts's; the
 * browser never reads a secret itself.
 */
export type SecretTyper = {
  name: string
  value(use: SecretUseContext): Promise<string>
}

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
