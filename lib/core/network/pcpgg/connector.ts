import net from "node:net"

import {
  CloseCode,
  DEFAULT_RELAY_URL,
  FINAL_CLOSE_CODES,
  PROTOCOL_VERSION,
  parseRelayMessage,
} from "./control"
import type { TunnelPort } from "./frames"
import { bridge, Mux } from "./mux"

/**
 * The connector: runs next to PCP, dials out to the pcp.gg relay, and
 * answers every connection the relay passes down by dialling PCP on this
 * computer. HTTPS connections arrive still encrypted and go to PCP's own
 * HTTPS listener, which holds the certificate for the owner's name, so the
 * TLS session runs from the assistant to PCP with nothing in between that
 * can read it.
 *
 * Lifted from tunnel/connector/connector.ts in kaperkunde/pcp-gg. PCP's
 * copy takes its targets as functions, because the edge's listeners come
 * and go with HTTPS (runtime.ts): a stream for a port that is not open is
 * refused rather than sent to whatever else listens there.
 */

export type ConnectorTarget = { host: string; port: number }

/** Where a stream goes, looked up for each one; null refuses it. */
export type ConnectorTargetSource =
  ConnectorTarget | (() => ConnectorTarget | null)

export type ConnectorState =
  "connecting" | "online" | "offline" | "unauthorized" | "stopped"

export type ConnectorStatus = {
  state: ConnectorState
  hostnames: string[]
  /** Why the last connection ended, in words for the owner. */
  lastError?: string
  /** When the next attempt is due, while offline. */
  retryAt?: Date
}

export type ConnectorOptions = {
  /** The connection key from the pcp.gg dashboard. */
  key: string
  relayUrl?: string
  /** PCP's HTTPS listener (its port 443, or 8443 in Docker). */
  https: ConnectorTargetSource
  /** PCP's HTTP listener (port 80, or 8080), for Let's Encrypt's challenge. */
  http: ConnectorTargetSource
  onStatus?: (status: ConnectorStatus) => void
  log?: (message: string) => void
  /** Identifies the connector to the relay; never carries anything personal. */
  client?: string
  /** For tests. */
  WebSocket?: typeof WebSocket
  backoff?: { firstMs: number; maxMs: number }
  pingIntervalMs?: number
}

export type Connector = {
  status(): ConnectorStatus
  stop(): Promise<void>
}

const CLOSE_MESSAGES: Record<number, string> = {
  [CloseCode.Unauthorized]:
    "pcp.gg did not accept this connection key. Copy a new one from your pcp.gg dashboard.",
  [CloseCode.Revoked]:
    "This connection key was replaced or removed on pcp.gg. Copy the new one from your dashboard.",
  [CloseCode.Replaced]:
    "Another PCP connected with the same key, so this one stepped aside.",
  [CloseCode.TryAgain]: "pcp.gg is restarting. Trying again shortly.",
  [CloseCode.Protocol]:
    "pcp.gg and this PCP did not understand each other. Update PCP.",
}

export function startConnector(options: ConnectorOptions): Connector {
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket
  const relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL
  const log = options.log ?? (() => {})
  const { firstMs, maxMs } = options.backoff ?? {
    firstMs: 1_000,
    maxMs: 60_000,
  }
  const pingIntervalMs = options.pingIntervalMs ?? 25_000

  let status: ConnectorStatus = { state: "connecting", hostnames: [] }
  let stopped = false
  let attempt = 0
  let ws: WebSocket | null = null
  let retryTimer: NodeJS.Timeout | undefined
  let stoppedResolve: (() => void) | null = null

  const setStatus = (next: ConnectorStatus) => {
    status = next
    options.onStatus?.(next)
  }

  const scheduleRetry = (lastError: string) => {
    attempt += 1
    const ceiling = Math.min(maxMs, firstMs * 2 ** Math.min(attempt - 1, 16))
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
    const retryAt = new Date(Date.now() + delay)
    setStatus({ state: "offline", hostnames: [], lastError, retryAt })
    retryTimer = setTimeout(connect, delay)
  }

  const connect = () => {
    if (stopped) {
      return
    }

    setStatus({ ...status, state: "connecting", retryAt: undefined })

    const socket = new WebSocketImpl(relayUrl)
    socket.binaryType = "arraybuffer"
    ws = socket

    let ready = false
    let lastHeard = Date.now()
    let pingTimer: NodeJS.Timeout | undefined

    const mux = new Mux(
      {
        send: (frame) => socket.send(frame),
        bufferedAmount: () => socket.bufferedAmount,
      },
      {
        role: "acceptor",
        onStream: (stream, meta) => {
          const source = meta.port === "https" ? options.https : options.http
          const target = typeof source === "function" ? source() : source

          if (!target) {
            stream.destroy(new Error(`PCP's ${portName(meta.port)} is closed`))
            return
          }

          const local = net.connect({ ...target, allowHalfOpen: true })
          local.setNoDelay(true)
          local.on("error", (error) => {
            log(
              `Could not reach PCP's ${portName(meta.port)}: ${error.message}`,
            )
          })
          bridge(stream, local)
        },
      },
    )

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          token: options.key,
          client: options.client ?? "pcp",
        }),
      )

      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > pingIntervalMs * 2.5) {
          log("pcp.gg stopped answering; reconnecting")
          socket.close()
          return
        }

        socket.send('{"type":"ping"}')
      }, pingIntervalMs)
    })

    socket.addEventListener("message", (event: MessageEvent) => {
      lastHeard = Date.now()

      if (typeof event.data !== "string") {
        try {
          mux.receive(new Uint8Array(event.data as ArrayBuffer))
        } catch (error) {
          log(`Tunnel error: ${(error as Error).message}`)
          socket.close(CloseCode.Protocol, "Protocol error")
        }
        return
      }

      const message = parseRelayMessage(event.data)

      if (message?.type === "ready") {
        ready = true
        attempt = 0
        log(`Online at ${message.hostnames.join(", ")}`)
        setStatus({ state: "online", hostnames: message.hostnames })
      }
    })

    socket.addEventListener("error", () => {
      // A close event always follows, and carries what there is to say.
    })

    socket.addEventListener("close", (event: CloseEvent) => {
      clearInterval(pingTimer)
      mux.close("pcp.gg connection closed")

      if (ws === socket) {
        ws = null
      }

      if (stopped) {
        setStatus({ state: "stopped", hostnames: [] })
        stoppedResolve?.()
        return
      }

      const message =
        CLOSE_MESSAGES[event.code] ??
        (ready
          ? "The connection to pcp.gg dropped."
          : "Could not reach pcp.gg. Is this computer online?")

      if (FINAL_CLOSE_CODES.has(event.code)) {
        log(message)
        setStatus({ state: "unauthorized", hostnames: [], lastError: message })
        return
      }

      log(`${message} Retrying.`)
      scheduleRetry(message)
    })
  }

  connect()

  return {
    status: () => status,
    stop: () => {
      stopped = true
      clearTimeout(retryTimer)

      if (!ws) {
        setStatus({ state: "stopped", hostnames: [] })
        return Promise.resolve()
      }

      return new Promise<void>((resolve) => {
        stoppedResolve = resolve
        ws?.close(1000, "Stopped")
      })
    },
  }
}

function portName(port: TunnelPort): string {
  return port === "https" ? "HTTPS port" : "HTTP port"
}
