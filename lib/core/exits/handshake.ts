import { isIP } from "node:net"
import type { Duplex } from "node:stream"

import { EXIT_HANDSHAKE_MAX_BYTES, EXIT_HANDSHAKE_TIMEOUT_MS } from "./limits"

/**
 * The client side of the two proxy handshakes an exit container speaks
 * (gluetun's HTTP proxy, wireproxy's SOCKS5): over a connection PCP already
 * has to the proxy (an SSH channel to the container's loopback port), ask
 * it to connect on to an address and port. The address is always an IP
 * that PCP resolved and checked itself (exits/check.ts), never a name, so
 * the proxy has nothing to resolve and nowhere else to go.
 *
 * Bytes the proxy sends after its answer (a server that speaks first) are
 * put back on the connection for whoever reads it next.
 */

export type ProxyAuth = { username: string; password: string }

export class ProxyHandshakeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProxyHandshakeError"
  }
}

type Parsed<T> = { consumed: number; value: T } | null

/**
 * Reads from `socket` until `parse` has what it needs. It reads in paused
 * mode ('readable' and read()), never 'data', so nothing flows past
 * unread: once it is done, anything after the reply is put back, and the
 * socket is left for whoever reads it next (a pipe, TLS) as if untouched.
 */
function readReply<T>(
  socket: Duplex,
  parse: (bytes: Buffer) => Parsed<T>,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    let done = false

    const finish = (error: Error | null, value?: T) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.off("readable", onReadable)
      socket.off("error", onError)
      socket.off("close", onClose)
      socket.off("end", onClose)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const onReadable = () => {
      let chunk: Buffer | null

      while (!done && (chunk = socket.read() as Buffer | null) !== null) {
        buffered = Buffer.concat([buffered, chunk])

        if (buffered.length > EXIT_HANDSHAKE_MAX_BYTES) {
          finish(new ProxyHandshakeError("The proxy's answer was too long."))
          return
        }

        let parsed: Parsed<T>

        try {
          parsed = parse(buffered)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }

        if (parsed) {
          const rest = buffered.subarray(parsed.consumed)
          finish(null, parsed.value)
          if (rest.length > 0) socket.unshift(rest)
        }
      }
    }
    const onError = (error: Error) => finish(error)
    const onClose = () =>
      finish(new ProxyHandshakeError("The proxy closed the connection."))
    const onAbort = () =>
      finish(
        signal?.reason instanceof Error ? signal.reason : new Error("aborted"),
      )
    const timer = setTimeout(
      () =>
        finish(
          new ProxyHandshakeError(
            `The proxy did not answer within ${timeoutMs / 1000} seconds.`,
          ),
        ),
      timeoutMs,
    )

    socket.on("readable", onReadable)
    socket.once("error", onError)
    socket.once("close", onClose)
    socket.once("end", onClose)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function requireIp(address: string): 4 | 6 {
  const family = isIP(address)

  if (family !== 4 && family !== 6) {
    throw new ProxyHandshakeError(
      "A proxy is only ever asked for an address PCP checked, never a name.",
    )
  }

  return family
}

function requirePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyHandshakeError("The port is a number from 1 to 65535.")
  }
}

// ---- HTTP CONNECT -----------------------------------------------------------

/**
 * Asks an HTTP proxy to open a tunnel to `address`:`port` (RFC 9110's
 * CONNECT). Resolves once it answered 2xx; the socket is then the tunnel.
 */
export async function httpConnect(
  socket: Duplex,
  address: string,
  port: number,
  {
    auth,
    timeoutMs = EXIT_HANDSHAKE_TIMEOUT_MS,
    signal,
  }: { auth?: ProxyAuth; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const family = requireIp(address)
  requirePort(port)
  const authority = `${family === 6 ? `[${address}]` : address}:${port}`
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    ...(auth
      ? [
          `Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
        ]
      : []),
  ]
  const reply = readReply(
    socket,
    (bytes) => {
      const end = bytes.indexOf("\r\n\r\n")
      if (end === -1) return null
      const head = bytes.subarray(0, end).toString("latin1")
      const status = /^HTTP\/1\.[01] (\d{3})(?: ([^\r\n]*))?/.exec(head)

      if (!status) {
        throw new ProxyHandshakeError("The proxy did not answer in HTTP.")
      }

      return {
        consumed: end + 4,
        value: { code: Number(status[1]), reason: status[2] ?? "" },
      }
    },
    { timeoutMs, signal },
  )

  socket.write(`${lines.join("\r\n")}\r\n\r\n`)
  const { code, reason } = await reply

  if (code === 407) {
    throw new ProxyHandshakeError(
      "The proxy wants a user name and password it was not given.",
    )
  }

  if (code < 200 || code > 299) {
    throw new ProxyHandshakeError(
      `The proxy would not connect to ${authority}: HTTP ${code}${reason ? ` ${reason.slice(0, 80)}` : ""}.`,
    )
  }
}

// ---- SOCKS5 -----------------------------------------------------------------

/** An IPv6 address's 16 bytes, from any of its written forms. */
export function ipv6Bytes(address: string): Buffer {
  let text = address.replace(/%.*$/, "")
  const bytes = Buffer.alloc(16)
  const tail: number[] = []

  // An IPv4 address at the end (::ffff:1.2.3.4) is its last 32 bits.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)

  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number)
    tail.push((parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!)
    text = text.slice(0, -dotted[1]!.length)
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1)
  }

  const [head, rest] = text.split("::") as [string, string | undefined]
  const groups = (part: string | undefined) =>
    part ? part.split(":").filter((group) => group !== "") : []
  const front = groups(head).map((group) => parseInt(group, 16))
  const back = [...groups(rest).map((group) => parseInt(group, 16)), ...tail]
  const missing = 8 - front.length - back.length

  if (missing < 0 || (rest === undefined && missing !== 0)) {
    throw new ProxyHandshakeError(`${address} is not an IPv6 address.`)
  }

  const all = [...front, ...Array<number>(missing).fill(0), ...back]
  all.forEach((group, index) => bytes.writeUInt16BE(group & 0xffff, index * 2))
  return bytes
}

const SOCKS_REPLIES: Record<number, string> = {
  1: "the proxy failed",
  2: "the proxy's rules do not allow it",
  3: "the network is unreachable from the proxy",
  4: "the host is unreachable from the proxy",
  5: "the connection was refused",
  6: "the proxy's time ran out",
  7: "the proxy does not connect",
  8: "the proxy does not take that kind of address",
}

/**
 * Asks a SOCKS5 proxy (RFC 1928, with RFC 1929's user name and password
 * when given) to connect to `address`:`port`. Resolves once it agreed; the
 * socket then carries the connection.
 */
export async function socks5Connect(
  socket: Duplex,
  address: string,
  port: number,
  {
    auth,
    timeoutMs = EXIT_HANDSHAKE_TIMEOUT_MS,
    signal,
  }: { auth?: ProxyAuth; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const family = requireIp(address)
  requirePort(port)
  const options = { timeoutMs, signal }
  const methods = auth ? [0x02] : [0x00]

  const chosen = readReply(
    socket,
    (bytes) =>
      bytes.length < 2 ? null : { consumed: 2, value: [bytes[0], bytes[1]] },
    options,
  )
  socket.write(Buffer.from([0x05, methods.length, ...methods]))
  const [version, method] = await chosen

  if (version !== 0x05) {
    throw new ProxyHandshakeError("The proxy does not speak SOCKS5.")
  }

  if (method === 0xff || !methods.includes(method!)) {
    throw new ProxyHandshakeError(
      auth
        ? "The proxy would not take a user name and password."
        : "The proxy wants a user name and password it was not given.",
    )
  }

  if (method === 0x02 && auth) {
    const user = Buffer.from(auth.username, "utf8")
    const pass = Buffer.from(auth.password, "utf8")

    if (user.length < 1 || user.length > 255 || pass.length > 255) {
      throw new ProxyHandshakeError(
        "The proxy's user name and password are 1 to 255 bytes each.",
      )
    }

    const status = readReply(
      socket,
      (bytes) => (bytes.length < 2 ? null : { consumed: 2, value: bytes[1] }),
      options,
    )
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, user.length]),
        user,
        Buffer.from([pass.length]),
        pass,
      ]),
    )

    if ((await status) !== 0x00) {
      throw new ProxyHandshakeError(
        "The proxy turned down its user name and password.",
      )
    }
  }

  const host =
    family === 4
      ? Buffer.from([0x01, ...address.split(".").map(Number)])
      : Buffer.concat([Buffer.from([0x04]), ipv6Bytes(address)])
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(port)

  const reply = readReply(
    socket,
    (bytes) => {
      if (bytes.length < 5) return null
      if (bytes[0] !== 0x05) {
        throw new ProxyHandshakeError("The proxy does not speak SOCKS5.")
      }
      const length =
        bytes[3] === 0x01
          ? 4
          : bytes[3] === 0x04
            ? 16
            : bytes[3] === 0x03
              ? 1 + bytes[4]!
              : -1
      if (length < 0) {
        throw new ProxyHandshakeError("The proxy's answer cannot be read.")
      }
      const total = 4 + length + 2
      return bytes.length < total ? null : { consumed: total, value: bytes[1] }
    },
    options,
  )
  socket.write(
    Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), host, portBytes]),
  )
  const code = await reply

  if (code !== 0x00) {
    throw new ProxyHandshakeError(
      `The proxy would not connect to ${family === 6 ? `[${address}]` : address}:${port}: ${SOCKS_REPLIES[code!] ?? `reply ${code}`}.`,
    )
  }
}
