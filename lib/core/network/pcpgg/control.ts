// A copy of tunnel/protocol/control.ts in kaperkunde/pcp-gg: keep the two the same.

/**
 * The control channel: text WebSocket messages, JSON. The connector speaks
 * first, with the key the owner copied from their pcp.gg dashboard; the
 * relay answers with the names it will route to this tunnel.
 */

export const PROTOCOL_VERSION = 1

/** The relay's tunnel address a connector dials by default. */
export const DEFAULT_RELAY_URL = "wss://tunnel.pcp.gg/v1/connect"

export const CloseCode = {
  /** The key is unknown or has been replaced: retrying will not help. */
  Unauthorized: 4001,
  /** A newer connection with the same key took over. */
  Replaced: 4002,
  /** The peer broke the protocol. */
  Protocol: 4003,
  /** The key was revoked, or the name released, while connected. */
  Revoked: 4004,
  /** The relay is restarting or busy: try again shortly. */
  TryAgain: 4005,
} as const

/** Close codes after which a connector stops instead of reconnecting. */
export const FINAL_CLOSE_CODES = new Set<number>([
  CloseCode.Unauthorized,
  CloseCode.Revoked,
])

export type ConnectorMessage =
  | { type: "hello"; protocol: number; token: string; client?: string }
  | { type: "ping" }

export type RelayMessage =
  { type: "ready"; hostnames: string[] } | { type: "pong" }

const MAX_CONTROL_BYTES = 4096

export function parseControl(text: string): Record<string, unknown> | null {
  if (text.length > MAX_CONTROL_BYTES) {
    return null
  }

  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function parseConnectorMessage(text: string): ConnectorMessage | null {
  const message = parseControl(text)

  if (message?.type === "ping") {
    return { type: "ping" }
  }

  if (
    message?.type === "hello" &&
    typeof message.protocol === "number" &&
    typeof message.token === "string" &&
    message.token.length > 0 &&
    message.token.length <= 256
  ) {
    return {
      type: "hello",
      protocol: message.protocol,
      token: message.token,
      client:
        typeof message.client === "string"
          ? message.client.slice(0, 100)
          : undefined,
    }
  }

  return null
}

export function parseRelayMessage(text: string): RelayMessage | null {
  const message = parseControl(text)

  if (message?.type === "pong") {
    return { type: "pong" }
  }

  if (
    message?.type === "ready" &&
    Array.isArray(message.hostnames) &&
    message.hostnames.every((name) => typeof name === "string")
  ) {
    return { type: "ready", hostnames: message.hostnames as string[] }
  }

  return null
}
