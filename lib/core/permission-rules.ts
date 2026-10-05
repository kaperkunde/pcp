import { createHash } from "node:crypto"

import {
  PERMISSION_DECISIONS,
  type PermissionDecision,
  type PermissionKind,
} from "./constants"
import { invalid } from "./errors"

/**
 * The decisions behind asking the owner before an assistant's call runs
 * (lib/core/permissions.ts), kept free of the database and the network so
 * they can be tested on their own.
 */

/**
 * How long a request stays answerable. Generous on purpose: people leave an
 * assistant working in the background and answer when they look.
 */
export const PERMISSION_TTL_MS = 24 * 60 * 60_000

/** Rows this long past their expiry are deleted at boot. */
export const PERMISSION_KEEP_MS = 7 * 24 * 60 * 60_000

export type PermissionStatus =
  "pending" | "running" | "executed" | "failed" | "declined"

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

/** The summary as plain text, for a tool result. */
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
  // Saved with the levels the owner chose on the page (applyAccessRequest),
  // never by a decision: the only one is no.
  access: {
    decline: "Not now",
  },
  endpoint_change: {
    allow_once: "Make the change",
    decline: "Not now",
  },
  // A site's answer, not the method's: the owner decides where it goes.
  fetch: {
    allow_once: "Allow once",
    always: "Always allow this site",
    block: "Block this site",
    decline: "Not now",
  },
  // The browser opening a site: the same lines as web fetch decide it.
  // Allow once lets that tab open the site's pages while it is open.
  browse: {
    allow_once: "Allow once",
    always: "Always allow this site",
    block: "Block this site",
    decline: "Not now",
  },
  // A tab the assistant handed over: the owner says when they are done.
  browser_handover: {
    allow_once: "Done",
    decline: "Not now",
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
