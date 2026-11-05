import type { SecretSitesShown } from "../browser-secrets"
import { siteKey } from "../fetch/rules"
import { describeRecipe } from "../generate-password"
import { visible, type ShownText } from "../permission-rules"
import { EVALUATE_TIMEOUT_MS, SECRET_SIGN_IN_WINDOW_MS } from "./limits"
import type {
  BrowseAsk,
  HandoverAsk,
  ScriptUseAsk,
  SecretRequestAsk,
  SecretSitesChangeAsk,
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
    title:
      ask.part === "username"
        ? `Type the login name of "${ask.secretName}" at ${hostOf(ask.origin)}?`
        : `Type the secret "${ask.secretName}" at ${hostOf(ask.origin)}?`,
    lines: [
      ...(ask.part === "username"
        ? ["The login name you keep with the secret, not its password."]
        : []),
      `Allow once is for one sign-in: this, then its other part (the login name or the password) in this tab within ${SECRET_SIGN_IN_WINDOW_MS / 60_000} minutes.`,
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
      ...(ask.username ? [`Login name: ${ask.username}`] : []),
      ...(ask.generate
        ? [
            `It asks PCP to make a new password: ${describeRecipe(ask.generate)}. Nobody sees it but you, on the Secrets page.`,
          ]
        : []),
      `Sites: ${ask.origins.join(", ")}`,
    ],
    warning:
      "Type the value here, on PCP's page, never in the conversation. The assistant gets the secret's name only, and PCP types it only at the sites you leave in.",
  }
}

/**
 * An assistant proposing to change where one of the owner's secrets is
 * typed: the sites it has now, each change, and a warning for a site that
 * looks like one it has without being it.
 */
export function describeSecretSitesChangeAsk(
  ask: SecretSitesChangeAsk,
  shown: SecretSitesShown,
): { title: string; lines: string[]; warning: string | null } {
  const lookalikes = shown.changes.flatMap((change) =>
    change.lookalike ? [change.lookalike] : [],
  )
  const fresh = shown.changes.filter((change) => change.newDomain)

  return {
    title: `Change where "${ask.secretName}" is typed?`,
    lines: [
      `It says: ${ask.reason}`,
      shown.exists
        ? `Sites now: ${shown.current.map((site) => (site.subdomains ? `${site.origin} and its subdomains` : site.origin)).join(", ") || "none"}`
        : `The secret "${ask.secretName}" is no longer in PCP.`,
      ...shown.changes.map(
        (change) =>
          `${change.action === "add" ? "Add" : "Take away"}: ${change.label}${change.noop ? " (already so)" : ""}`,
      ),
    ],
    warning:
      lookalikes.length > 0
        ? `Check these: ${lookalikes.join(" ")} They are left unticked; tick one only if it is the site you mean.`
        : fresh.length > 0
          ? `${fresh.map((change) => change.origin).join(", ")} ${fresh.length === 1 ? "is" : "are"} under another domain than the secret's sites: make sure it belongs to the same sign-in.`
          : null,
  }
}

/**
 * An assistant's script to run in a tab: the site, the page, and the whole
 * script, shown open (`full`) for the owner to read before it runs.
 */
export function describeScriptUseAsk(ask: ScriptUseAsk): {
  title: string
  lines: string[]
  warning: string | null
  full: ShownText[]
} {
  const lines = ask.script.split("\n").length

  return {
    title: `Run an assistant's script at ${ask.site}?`,
    lines: [
      `Site: ${ask.site}`,
      `Page: ${ask.title || "(no title)"}`,
      `Address: ${ask.url}`,
      `In tab ${ask.tabId}`,
      `The script: ${ask.script.length.toLocaleString("en")} characters, ${lines} line${lines === 1 ? "" : "s"}, shown in full below`,
      `While it runs the tab reaches this site only, and it stops after ${EVALUATE_TIMEOUT_MS / 1000} seconds.`,
    ],
    warning:
      "A script runs as the page's own do: signed in as you where you signed in to this site in the browser, it can read what the page and its scripts see (its storage, cookies a script may read) and act on the site as you. Read it whole before you let it run.",
    full: [{ label: "The script", text: visible(ask.script) }],
  }
}
