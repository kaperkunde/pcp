import { siteKey } from "../fetch/rules"
import type {
  BrowseAsk,
  HandoverAsk,
  SecretRequestAsk,
  SecretUseAsk,
} from "./types"

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
    lines: ask.exit
      ? [
          `Address: ${ask.url}`,
          `In a new tab through the exit ${ask.exit}: signed in to nothing, and nothing it does is saved`,
          privateAllowed
            ? "Public addresses, and the exit's own network, since you allowed private addresses for this token"
            : "Public addresses only",
        ]
      : [
          `Address: ${ask.url}`,
          ask.tabId ? `In tab ${ask.tabId}` : "In a new tab",
          privateAllowed
            ? "In PCP's browser, from PCP's own address; your own network too, since you allowed private addresses for this token"
            : "In PCP's browser, from PCP's own address, public addresses only",
        ],
    warning: ask.exit
      ? null
      : "The browser keeps your sign-ins: where you have signed in to this site in it, the assistant acts as you there.",
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

/**
 * Typing one of the owner's secrets into a page: its name, never its
 * value, and where it would go. `bound`: the site is one of the secret's.
 */
export function describeSecretUseAsk(
  ask: SecretUseAsk,
  { bound }: { bound: boolean },
): { title: string; lines: string[]; warning: string | null } {
  const plain = ask.origin.startsWith("http:")

  return {
    title: `Type the secret "${ask.secretName}" at ${hostOf(ask.origin)}?`,
    lines: [
      `Site: ${ask.origin}`,
      `Into: ${ask.field}`,
      `Page: ${ask.title || "(no title)"}`,
      `Address: ${ask.url}`,
      `In tab ${ask.tabId}`,
      bound
        ? `${ask.origin} is one of the sites of "${ask.secretName}".`
        : `PCP has not typed "${ask.secretName}" at ${ask.origin} before: Always allow adds it to the secret's sites.`,
    ],
    warning: [
      ...(bound
        ? []
        : [
            "Check the site: is this where the secret belongs? A page elsewhere could be after it.",
          ]),
      ...(plain
        ? [
            "The page is not encrypted (http://): the secret travels unprotected.",
          ]
        : []),
      "PCP types the value itself and the assistant never sees it, but the site receives it, as when you type it yourself.",
    ].join(" "),
  }
}

/** An assistant asking the owner to store a secret for the browser. */
export function describeSecretRequestAsk(ask: SecretRequestAsk): {
  title: string
  lines: string[]
  warning: string | null
} {
  return {
    title: `Store "${ask.name}" for the browser to type?`,
    lines: [
      `It says: ${ask.purpose}`,
      ask.kind === "totp"
        ? "One-time codes (TOTP): the seed the site showed when you set them up, base32 or an otpauth:// link. PCP types the code of the moment."
        : "A password or other text, typed as it is.",
      `Sites: ${ask.origins.join(", ")}`,
    ],
    warning:
      "Type the value here, on PCP's page, never in the conversation. The assistant gets the secret's name only, and PCP types it only at the sites you leave in.",
  }
}
