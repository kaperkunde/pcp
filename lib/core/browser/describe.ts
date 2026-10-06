import { siteKey } from "../fetch/rules"
import type { BrowseAsk, HandoverAsk } from "./types"

/**
 * What the owner is shown on PCP's page before the browser opens a site an
 * assistant asked for, or when an assistant hands them a tab.
 */

function hostOf(url: string): string {
  try {
    return siteKey(new URL(url))
  } catch {
    return url
  }
}

export function describeBrowseAsk(
  ask: BrowseAsk,
  { privateAllowed = false }: { privateAllowed?: boolean } = {},
): { title: string; lines: string[]; warning: string | null } {
  const host = hostOf(ask.url)

  return {
    title: `Open ${host} in the browser?`,
    lines: [
      `Address: ${ask.url}`,
      ask.tabId ? `In tab ${ask.tabId}` : "In a new tab",
      privateAllowed
        ? "In PCP's browser, from PCP's own address; your own network too, since you allowed private addresses for this token"
        : "In PCP's browser, from PCP's own address, public addresses only",
    ],
    warning:
      "The browser keeps your sign-ins: where you have signed in to this site in it, the assistant acts as you there.",
  }
}

export function describeHandoverAsk(ask: HandoverAsk): {
  title: string
  lines: string[]
  warning: string | null
} {
  return {
    title: "An assistant needs you in the browser",
    lines: [
      `It says: ${ask.message}`,
      `Tab: ${ask.title || "(no title)"}`,
      `Address: ${ask.url}`,
    ],
    warning:
      "The message is the assistant's words. It cannot use the tab while you have it, but it reads the page once you say you are done.",
  }
}
