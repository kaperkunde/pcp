import type { Socket } from "node:net"

/**
 * Reads the name (SNI) and the protocols (ALPN) a TLS client asks for from
 * its first message, the ClientHello, which is sent in the clear before any
 * key is agreed. The edge (edge.ts) looks at it only while a TLS-ALPN-01
 * challenge is waiting, to tell Let's Encrypt's validation apart from
 * everyone else's connections; Node's TLS server decides on the certificate
 * before it says which protocols the client offered.
 *
 * Adapted from pcp.gg's `tunnel/protocol/sni.ts` (kaperkunde/pcp-gg), which
 * reads only the name.
 */

const CONTENT_HANDSHAKE = 22
const HANDSHAKE_CLIENT_HELLO = 1
const EXTENSION_SERVER_NAME = 0
const EXTENSION_ALPN = 16
const NAME_TYPE_HOST = 0
const MAX_RECORD = 16384 + 2048

export type ClientHello = {
  serverName: string | null
  /** The protocols offered, in the client's order; empty without ALPN. */
  protocols: string[]
}

export type ClientHelloResult =
  | { status: "more" }
  | { status: "invalid"; reason: string }
  | ({ status: "done" } & ClientHello)

class Cursor {
  offset = 0
  readonly data: Uint8Array

  constructor(data: Uint8Array) {
    this.data = data
  }

  need(bytes: number): void {
    if (this.offset + bytes > this.data.byteLength) {
      throw new RangeError("truncated")
    }
  }

  u8(): number {
    this.need(1)
    return this.data[this.offset++]!
  }

  u16(): number {
    return (this.u8() << 8) | this.u8()
  }

  bytes(length: number): Uint8Array {
    this.need(length)
    const slice = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }

  skip(length: number): void {
    this.need(length)
    this.offset += length
  }

  get done(): boolean {
    return this.offset >= this.data.byteLength
  }
}

/** A hostname as it may appear in SNI: letters, digits, dots and hyphens. */
export function normalizeServerName(raw: string): string | null {
  const name = raw.toLowerCase().replace(/\.$/, "")

  if (
    name.length === 0 ||
    name.length > 253 ||
    !/^[a-z0-9.-]+$/.test(name) ||
    name.split(".").some((label) => label.length === 0 || label.length > 63)
  ) {
    return null
  }

  return name
}

function readServerName(data: Uint8Array): string | null {
  const list = new Cursor(data)
  const names = new Cursor(list.bytes(list.u16()))

  while (!names.done) {
    const nameType = names.u8()
    const name = names.bytes(names.u16())

    if (nameType === NAME_TYPE_HOST) {
      return normalizeServerName(new TextDecoder().decode(name))
    }
  }

  return null
}

function readProtocols(data: Uint8Array): string[] {
  const list = new Cursor(data)
  const entries = new Cursor(list.bytes(list.u16()))
  const protocols: string[] = []

  while (!entries.done) {
    protocols.push(new TextDecoder().decode(entries.bytes(entries.u8())))
  }

  return protocols
}

function parseClientHelloBody(body: Uint8Array): ClientHello {
  const hello: ClientHello = { serverName: null, protocols: [] }
  const cursor = new Cursor(body)
  cursor.skip(2) // legacy_version
  cursor.skip(32) // random
  cursor.skip(cursor.u8()) // legacy_session_id
  cursor.skip(cursor.u16()) // cipher_suites
  cursor.skip(cursor.u8()) // legacy_compression_methods

  if (cursor.done) {
    return hello // no extensions at all
  }

  const extensions = new Cursor(cursor.bytes(cursor.u16()))

  while (!extensions.done) {
    const type = extensions.u16()
    const data = extensions.bytes(extensions.u16())

    if (type === EXTENSION_SERVER_NAME) {
      hello.serverName = readServerName(data)
    } else if (type === EXTENSION_ALPN) {
      hello.protocols = readProtocols(data)
    }
  }

  return hello
}

/** Looks at what has arrived so far; may be asked again with more. */
export function parseClientHello(data: Uint8Array): ClientHelloResult {
  const handshake: Uint8Array[] = []
  let handshakeLength = 0
  let offset = 0

  while (offset + 5 <= data.byteLength) {
    if (data[offset] !== CONTENT_HANDSHAKE) {
      return { status: "invalid", reason: "not a TLS handshake" }
    }

    const recordLength = (data[offset + 3]! << 8) | data[offset + 4]!

    if (recordLength === 0 || recordLength > MAX_RECORD) {
      return { status: "invalid", reason: "bad TLS record length" }
    }

    if (offset + 5 + recordLength > data.byteLength) {
      return { status: "more" }
    }

    const fragment = data.subarray(offset + 5, offset + 5 + recordLength)
    handshake.push(fragment)
    handshakeLength += fragment.byteLength
    offset += 5 + recordLength

    if (handshakeLength < 4) {
      continue
    }

    const message = Buffer.concat(handshake)

    if (message[0] !== HANDSHAKE_CLIENT_HELLO) {
      return { status: "invalid", reason: "first message is not ClientHello" }
    }

    const bodyLength = (message[1]! << 16) | (message[2]! << 8) | message[3]!

    if (message.byteLength >= 4 + bodyLength) {
      try {
        return {
          status: "done",
          ...parseClientHelloBody(message.subarray(4, 4 + bodyLength)),
        }
      } catch {
        return { status: "invalid", reason: "malformed ClientHello" }
      }
    }
  }

  if (offset === 0 && data.byteLength > 0 && data[0] !== CONTENT_HANDSHAKE) {
    return { status: "invalid", reason: "not a TLS handshake" }
  }

  return { status: "more" }
}

/**
 * Collects the start of a connection until the ClientHello is complete (or
 * is not one), then hands back what it says and every byte read, so the
 * bytes can be put back for the TLS server. The socket is left paused.
 */
export function peekClientHello(
  socket: Socket,
  { timeoutMs = 10_000, maxBytes = 32 * 1024 } = {},
): Promise<{
  result: Exclude<ClientHelloResult, { status: "more" }>
  head: Buffer
}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    const finish = (
      error: Error | null,
      result?: Exclude<ClientHelloResult, { status: "more" }>,
    ) => {
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("end", onEnd)
      socket.pause()

      if (error || !result) {
        reject(error ?? new Error("No ClientHello"))
      } else {
        resolve({ result, head: Buffer.concat(chunks, total) })
      }
    }

    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.byteLength
      const result = parseClientHello(Buffer.concat(chunks, total))

      if (result.status !== "more") {
        finish(null, result)
      } else if (total >= maxBytes) {
        finish(new Error("Too much data before the ClientHello ended"))
      }
    }
    const onError = (error: Error) => finish(error)
    const onEnd = () => finish(new Error("Connection ended early"))
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the client")),
      timeoutMs,
    )

    socket.on("data", onData)
    socket.on("error", onError)
    socket.on("end", onEnd)
    socket.resume()
  })
}
