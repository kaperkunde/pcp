/**
 * Client profiles: what PCP knows about the apps that call /mcp, and the
 * little it does differently for each. Data, not code paths: adding an app
 * is adding an entry here, with the date its behaviour was last looked at.
 *
 * A profile changes only answers, never a tool's name or description, which
 * stay the same in every session so a client's "Always allow" holds:
 *
 * - mirrorInstructions: the app does not show the model the server's
 *   instructions, so their key rules are repeated in answers (read_memory
 *   every, and the first search or describe of a session).
 * - linkStyle: how a link for the owner is written. Every app known today
 *   reads a markdown link; another style is added here and in owner-link.ts.
 *
 * Pure: the token's Advanced page lists these, and nothing here may import
 * more than this.
 */

export const CLIENT_PROFILE_IDS = [
  "claude-code",
  "claude-ai",
  "chatgpt",
  "generic",
] as const

export type ClientProfileId = (typeof CLIENT_PROFILE_IDS)[number]

export type LinkStyle = "markdown"

/** What a request may say about the app sending it. */
export type ClientSignals = {
  /** clientInfo.name, from initialize or a request's _meta. */
  clientName?: string
  userAgent?: string
  /** The values of the headers that label the client, by lower-case name. */
  headers?: Record<string, string>
  /** The name the client gave when it signed in with OAuth. */
  oauthClientName?: string
}

export type ClientProfile = {
  id: ClientProfileId
  /** What the owner sees in the token's settings. */
  label: string
  /** Any one of these matching picks the profile (see matchProfile). */
  match: {
    clientName?: RegExp
    userAgent?: RegExp
    headers?: Record<string, RegExp>
    oauthClientName?: RegExp
  }
  /** When the app was last seen to behave as this says; null: assumed. */
  observed: string | null
  mirrorInstructions: boolean
  linkStyle: LinkStyle
  notes: string
}

export const CLIENT_PROFILES: readonly ClientProfile[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    match: {
      clientName: /^claude-code$/i,
      userAgent: /\bclaude-code\b/i,
      oauthClientName: /^claude code\b/i,
    },
    observed: "2026-11-02",
    mirrorInstructions: false,
    linkStyle: "markdown",
    notes:
      "Shows the server's instructions (their first couple of thousand characters) and loads tools by search; nothing needs repeating.",
  },
  {
    id: "claude-ai",
    label: "Claude apps (chat, voice, mobile)",
    match: {
      clientName: /^claude-ai$/i,
      headers: { "x-anthropic-client": /^claude-ai\b/i },
      userAgent: /^Claude-User\b/i,
      oauthClientName: /^claude(\.ai)?$/i,
    },
    observed: "2026-11-02",
    mirrorInstructions: true,
    linkStyle: "markdown",
    notes:
      "Seen in Claude for iOS voice: the server's instructions never reach the model, each tool is deferred with some 25 characters of its description after the connector's name, and search is by keywords over names and that text. Reads a markdown link's label aloud.",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    match: {
      clientName: /^openai-mcp$|chatgpt/i,
      userAgent: /\bopenai-mcp\b|chatgpt/i,
      oauthClientName: /chatgpt|openai/i,
    },
    observed: null,
    mirrorInstructions: true,
    linkStyle: "markdown",
    notes:
      "Assumed, not yet observed: treated as an app that does not show the server's instructions to the model.",
  },
  {
    id: "generic",
    label: "Any other app",
    match: {},
    observed: null,
    mirrorInstructions: false,
    linkStyle: "markdown",
    notes:
      "An app PCP does not know: the instructions are given as MCP says, and answers carry nothing extra.",
  },
]

export const GENERIC_PROFILE = CLIENT_PROFILES.find(
  (profile) => profile.id === "generic",
)!

export function isClientProfileId(value: unknown): value is ClientProfileId {
  return (
    typeof value === "string" &&
    (CLIENT_PROFILE_IDS as readonly string[]).includes(value)
  )
}

/** The profile by id; the generic one for an id PCP no longer has. */
export function clientProfile(id: string | null | undefined): ClientProfile {
  return CLIENT_PROFILES.find((profile) => profile.id === id) ?? GENERIC_PROFILE
}

/**
 * The profile a request's signals point at, the strongest signal first:
 * the client's own name, then a header that labels it, then its user
 * agent, then the name it signed in with. The generic profile when none
 * matches.
 */
export function matchProfile(signals: ClientSignals): ClientProfile {
  const tests: Array<(profile: ClientProfile) => boolean> = [
    (profile) =>
      signals.clientName !== undefined &&
      profile.match.clientName?.test(signals.clientName) === true,
    (profile) =>
      Object.entries(profile.match.headers ?? {}).some(([name, pattern]) => {
        const value = signals.headers?.[name]
        return value !== undefined && pattern.test(value)
      }),
    (profile) =>
      signals.userAgent !== undefined &&
      profile.match.userAgent?.test(signals.userAgent) === true,
    (profile) =>
      signals.oauthClientName !== undefined &&
      profile.match.oauthClientName?.test(signals.oauthClientName) === true,
  ]

  for (const test of tests) {
    const found = CLIENT_PROFILES.find(test)

    if (found) {
      return found
    }
  }

  return GENERIC_PROFILE
}
