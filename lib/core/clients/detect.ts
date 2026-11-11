import type { ClientInfo, RequestClient } from "../client-hello"
import { db } from "../db"
import {
  clientProfile,
  isClientProfileId,
  matchProfile,
  type ClientProfile,
  type ClientProfileId,
} from "./profiles"
import { sessionKey, startSession } from "./sessions"

/**
 * Which app a request to /mcp comes from, and the profile PCP answers it
 * with (profiles.ts): the owner's choice for the token when they made one,
 * else what the request shows. A 2026-07-28 request names its client in
 * every request; under the older protocol only initialize does, so the last
 * client a token named is remembered here (in memory, bounded) and, past a
 * restart, read from the token's client_seen. The user agent, the headers
 * that label the client and the name it signed in with count too.
 *
 * The client last seen is kept on the token (client_seen: name, version,
 * profile, time) for the owner's Advanced page: the client's own words about
 * itself, never a request's content, and not the request log, which lists
 * calls.
 */

/** What api_token.client_seen holds. */
export type ClientSeenRecord = {
  name?: string
  version?: string
  /** The profile its requests pointed at (not the owner's choice). */
  profile: ClientProfileId
  /** ISO time. */
  at: string
}

export type DetectedClient = {
  /** The profile in force: the owner's choice, else the detected one. */
  profile: ClientProfile
  /** The profile the request pointed at. */
  detected: ClientProfile
  /** The owner chose the profile for this token. */
  chosen: boolean
  name?: string
  version?: string
  /** The session the request belongs to (sessions.ts). */
  sessionKey: string
}

/** The token's side of detection, as ResolvedToken carries it. */
export type TokenClient = {
  tokenId: string
  /** The owner's choice; null detects. */
  clientProfile: ClientProfileId | null
  oauthClientName: string | null
  clientSeen: ClientSeenRecord | null
}

const MAX_TEXT = 200
const MAX_REMEMBERED = 1_000
/** How often client_seen is written again when nothing about it changed. */
export const CLIENT_SEEN_INTERVAL_MS = 5 * 60 * 1000

const remembered = new Map<string, ClientInfo>()

function remember(tokenId: string, client: ClientInfo) {
  remembered.delete(tokenId)
  remembered.set(tokenId, client)

  if (remembered.size > MAX_REMEMBERED) {
    remembered.delete(remembered.keys().next().value as string)
  }
}

function shortText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_TEXT)
    : undefined
}

/** client_seen as stored, or null when it is empty or not one. */
export function parseClientSeen(
  json: string | null | undefined,
): ClientSeenRecord | null {
  if (!json) {
    return null
  }

  try {
    const value: unknown = JSON.parse(json)

    if (!value || typeof value !== "object") {
      return null
    }

    const record = value as Record<string, unknown>
    const name = shortText(record.name)
    const version = shortText(record.version)

    if (!isClientProfileId(record.profile) || typeof record.at !== "string") {
      return null
    }

    return {
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      profile: record.profile,
      at: record.at,
    }
  } catch {
    return null
  }
}

/** The owner's choice as stored, or null for none (or one PCP dropped). */
export function chosenProfile(
  stored: string | null | undefined,
): ClientProfileId | null {
  return isClientProfileId(stored) ? stored : null
}

/**
 * The client of one request and the profile it is answered with. An
 * initialize starts its session over.
 */
export function detectClient(
  token: TokenClient,
  request: RequestClient,
): DetectedClient {
  if (request.client) {
    remember(token.tokenId, request.client)
  }

  const client: ClientInfo | undefined =
    request.client ??
    remembered.get(token.tokenId) ??
    (token.clientSeen?.name
      ? { name: token.clientSeen.name, version: token.clientSeen.version }
      : undefined)
  const detected = matchProfile({
    clientName: client?.name,
    userAgent: request.userAgent,
    headers: request.labels,
    oauthClientName: token.oauthClientName ?? undefined,
  })
  const chosen = token.clientProfile !== null
  const key = sessionKey(token.tokenId, client?.name ?? detected.id)

  if (request.initialize) {
    startSession(key)
  }

  return {
    profile: chosen ? clientProfile(token.clientProfile) : detected,
    detected,
    chosen,
    ...(client?.name ? { name: client.name } : {}),
    ...(client?.version ? { version: client.version } : {}),
    sessionKey: key,
  }
}

/** What client_seen becomes for a detected client. */
export function seenRecord(
  detected: DetectedClient,
  now = new Date(),
): ClientSeenRecord {
  return {
    ...(detected.name ? { name: detected.name } : {}),
    ...(detected.version ? { version: detected.version } : {}),
    profile: detected.detected.id,
    at: now.toISOString(),
  }
}

/** Whether client_seen needs writing: something changed, or it is stale. */
export function seenChanged(
  previous: ClientSeenRecord | null,
  next: ClientSeenRecord,
): boolean {
  return (
    !previous ||
    previous.name !== next.name ||
    previous.version !== next.version ||
    previous.profile !== next.profile ||
    Date.parse(next.at) - Date.parse(previous.at) > CLIENT_SEEN_INTERVAL_MS
  )
}

/**
 * Keeps the client last seen on the token, when it changed or was last
 * written a while ago. Returns whether it wrote.
 */
export async function noteClientSeen(
  token: Pick<TokenClient, "tokenId" | "clientSeen">,
  detected: DetectedClient,
  now = new Date(),
): Promise<boolean> {
  const next = seenRecord(detected, now)

  if (!seenChanged(token.clientSeen, next)) {
    return false
  }

  await db().apiToken.update({
    where: { id: token.tokenId },
    data: { clientSeen: JSON.stringify(next) },
  })
  return true
}
