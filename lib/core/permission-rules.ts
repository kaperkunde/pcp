import { createHash } from "node:crypto"

import type { ClientCapabilities } from "@modelcontextprotocol/server"

import {
  OPTIONAL_PERMISSION_TIERS,
  PERMISSION_DECISIONS,
  PERMISSION_TIERS,
  type PermissionDecision,
  type PermissionKind,
  type PermissionTier,
} from "./constants"
import { invalid } from "./errors"

/**
 * The decisions behind asking the owner before an assistant's call runs
 * (lib/core/permissions.ts), kept free of the database and the network so
 * they can be tested on their own. Ported from plekje's confirm-rules.
 */

/**
 * How long a request stays answerable. Generous on purpose: people leave an
 * assistant working in the background and answer when they look.
 */
export const PERMISSION_TTL_MS = 24 * 60 * 60_000

/** Rows this long past their expiry are deleted at boot. */
export const PERMISSION_KEEP_MS = 7 * 24 * 60 * 60_000

/** The MCP Apps extension a client declares when it can show a panel. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui"

export type PermissionStatus =
  "pending" | "running" | "executed" | "failed" | "declined"

/** Where the owner answered. */
export type PermissionVia = "app" | "form" | "url" | "web"

/**
 * How the owner is asked:
 * - app: the PCP panel, for clients that render MCP Apps. First, because a
 *   client can declare form elicitation and never show it (the call hangs),
 *   while a panel it never mounts still leaves the link in the text.
 * - form: the client's own prompt (elicitation, form mode).
 * - url: the client opens PCP's permission page itself (elicitation, URL mode).
 * - link: nothing the client can show, so the text hands the assistant a
 *   link to give the owner. Every 2025-era request lands here: it carries no
 *   capabilities, and the SDK refuses a multi-round answer to it.
 *
 * A client's word is all there is to go on, and some clients declare form
 * elicitation they never show. So each token says which tiers it may use
 * (`allowed`); the first one the client declares and the token allows wins,
 * and the link is always left.
 */
export function choosePermissionTier(
  capabilities: ClientCapabilities | undefined,
  allowed: readonly PermissionTier[] = PERMISSION_TIERS,
): PermissionTier {
  if (!capabilities) {
    return "link"
  }

  const extensions = (capabilities as { extensions?: Record<string, unknown> })
    .extensions
  const elicitation = capabilities.elicitation as
    { form?: unknown; url?: unknown } | undefined
  const declared: Record<(typeof OPTIONAL_PERMISSION_TIERS)[number], boolean> =
    {
      app: Boolean(extensions?.[UI_EXTENSION]),
      // An empty elicitation object is form mode (the spec's default).
      form: Boolean(elicitation && (elicitation.form || !elicitation.url)),
      url: Boolean(elicitation?.url),
    }

  return (
    OPTIONAL_PERMISSION_TIERS.find(
      (tier) => declared[tier] && allowed.includes(tier),
    ) ?? "link"
  )
}

/**
 * A token's stored tiers ("app,form,url") as a list in trying order. Names
 * PCP does not know are dropped; the link is always there.
 */
export function parsePermissionTiers(stored: string): PermissionTier[] {
  const named = new Set(stored.split(",").map((name) => name.trim()))

  return PERMISSION_TIERS.filter((tier) => tier === "link" || named.has(tier))
}

/** The tiers to store for a token; the link is implied, not stored. */
export function storePermissionTiers(tiers: readonly string[]): string {
  for (const tier of tiers) {
    if (!(PERMISSION_TIERS as readonly string[]).includes(tier)) {
      throw invalid("Choose how PCP asks you from the options shown.")
    }
  }

  return OPTIONAL_PERMISSION_TIERS.filter((tier) => tiers.includes(tier)).join(
    ",",
  )
}

/** JSON with sorted keys and no undefined values, so equal args hash equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}

/**
 * What makes two requests the same one: the kind, what it targets (the
 * server and tool for a call, the address for a new server) and the
 * arguments.
 */
export function requestHash(
  kind: PermissionKind,
  target: string,
  args: unknown,
): string {
  return createHash("sha256")
    .update(`${kind}\n${target}\n${canonicalJson(args)}`)
    .digest("hex")
}

/**
 * A result's text, cut to what is worth keeping on the row. `notes` (where
 * the whole answer was kept) survive the cut, so the assistant that asks
 * how it went can still read the rest.
 */
export function storedResultText(
  texts: string[],
  max = 20_000,
  notes: string[] = [],
): string {
  const joined = texts.join("\n")

  if (joined.length <= max) {
    return joined
  }

  const kept = joined.slice(0, max)
  const lost = notes.filter((note) => !kept.includes(note))

  return [`${kept}\n… (truncated)`, ...lost].join("\n")
}

/** Whether a pending request can still be answered. */
export function isOpen(
  row: { status: string; expiresAt: Date },
  now = new Date(),
): boolean {
  return row.status === "pending" && row.expiresAt.getTime() > now.getTime()
}

/** One line per top-level argument, for the owner to read. */
export function previewArgs(
  args: Record<string, unknown>,
  max = 800,
): string[] {
  const entries = Object.entries(args).filter(
    ([, value]) => value !== undefined,
  )

  if (entries.length === 0) {
    return ["(no arguments)"]
  }

  return entries.map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    const clipped = text.length > max ? `${text.slice(0, max - 1)}…` : text

    return `${key}: ${clipped}`
  })
}

/** The summary as plain text, for a prompt or a tool result. */
export function summaryText(summary: {
  title: string
  lines: string[]
  warning?: string | null
}): string {
  return [
    summary.title,
    ...summary.lines.map((line) => `- ${line}`),
    ...(summary.warning ? [summary.warning] : []),
  ].join("\n")
}

const DECISION_LABELS: Record<PermissionKind, Record<string, string>> = {
  call: {
    allow_once: "Allow once",
    always: "Always allow",
    block: "Block",
    decline: "Not now",
  },
  register: {
    allow_once: "Add server",
    decline: "Not now",
  },
  // Not now keeps it for the assistant that asked: a memory of its own needs
  // nobody's say. Discard is the answer to text the owner does not want kept.
  memory_share: {
    allow_once: "Share it",
    decline: "Keep it for this assistant only",
    discard: "Discard it",
  },
  memory_change: {
    allow_once: "Allow the change",
    decline: "Not now",
  },
}

const SCHEMA_WORDS: Record<
  PermissionKind,
  { title: string; description: string }
> = {
  call: {
    title: "Your answer",
    description: "Always allow and Block also decide the calls after this one.",
  },
  register: {
    title: "Add this server?",
    description: "The server is only added if you say so.",
  },
  memory_share: {
    title: "Share this memory?",
    description:
      "Shared, every assistant that keeps memories reads it. Kept, only this one does.",
  },
  memory_change: {
    title: "Change this shared memory?",
    description: "Nothing changes unless you say so.",
  },
}

/** The answers the owner is offered, in order, with their labels. */
export function decisionsFor(
  kind: PermissionKind,
): Array<{ value: PermissionDecision; label: string }> {
  return PERMISSION_DECISIONS.filter(
    (value) => DECISION_LABELS[kind][value] !== undefined,
  ).map((value) => ({ value, label: DECISION_LABELS[kind][value] }))
}

export function parseDecision(
  kind: PermissionKind,
  value: unknown,
): PermissionDecision {
  const offered = decisionsFor(kind).map((decision) => decision.value)

  if (typeof value === "string" && offered.includes(value as never)) {
    return value as PermissionDecision
  }

  throw invalid(`Answer with one of: ${offered.join(", ")}.`)
}

/**
 * The form the owner fills in when the client shows its own prompt: one
 * choice, labelled (the spec's titled single-select enum).
 */
export function decisionSchema(kind: PermissionKind) {
  return {
    type: "object" as const,
    properties: {
      decision: {
        type: "string" as const,
        title: SCHEMA_WORDS[kind].title,
        description: SCHEMA_WORDS[kind].description,
        oneOf: decisionsFor(kind).map((decision) => ({
          const: decision.value,
          title: decision.label,
        })),
      },
    },
    required: ["decision"],
  }
}
