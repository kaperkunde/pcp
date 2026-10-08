// A copy of tunnel/protocol/sni.ts in kaperkunde/pcp-gg: only the relay
// (relay.ts) uses it.

import type { Socket } from "node:net"

/**
 * Reads the name a TLS client asks for (Server Name Indication) from its
 * first message, the ClientHello, without taking part in the handshake. The
 * ClientHello is sent in the clear before any key is agreed; everything
 * after it is encrypted for the owner's computer alone. This is the only
 * thing the relay reads from an HTTPS connection.
 */

const CONTENT_HANDSHAKE = 22
const HANDSHAKE_CLIENT_HELLO = 1
const EXTENSION_SERVER_NAME = 0
const NAME_TYPE_HOST = 0
const MAX_RECORD = 16384 + 2048

export type SniResult =
  | { status: "more" }
  | { status: "invalid"; reason: string }
  | { status: "done"; serverName: string | null }

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

  u24(): number {
    return (this.u8() << 16) | (this.u8() << 8) | this.u8()
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

function parseClientHelloBody(body: Uint8Array): string | null {
  const cursor = new Cursor(body)
  cursor.skip(2) // legacy_version
  cursor.skip(32) // random
  cursor.skip(cursor.u8()) // legacy_session_id
  cursor.skip(cursor.u16()) // cipher_suites
  cursor.skip(cursor.u8()) // legacy_compression_methods

  if (cursor.offset === body.byteLength) {
    return null // no extensions at all
  }

  const extensions = new Cursor(cursor.bytes(cursor.u16()))

  while (extensions.offset < extensions.data.byteLength) {
    const type = extensions.u16()
    const data = extensions.bytes(extensions.u16())

    if (type !== EXTENSION_SERVER_NAME) {
      continue
    }

    const list = new Cursor(data)
    const names = new Cursor(list.bytes(list.u16()))

    while (names.offset < names.data.byteLength) {
      const nameType = names.u8()
      const name = names.bytes(names.u16())

      if (nameType === NAME_TYPE_HOST) {
        return normalizeServerName(new TextDecoder().decode(name))
      }
    }

    return null
  }

  return null
}

/** Looks at what has arrived so far; may be asked again with more. */
export function parseSni(data: Uint8Array): SniResult {
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
          serverName: parseClientHelloBody(message.subarray(4, 4 + bodyLength)),
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

export type PeekOptions = {
  timeoutMs?: number
  maxBytes?: number
}

/**
 * Collects the start of a connection until `parse` has an answer, then
 * hands back the answer and every byte read, so nothing is lost when the
 * connection is passed on. The socket is left paused.
 */
export function peek<T>(
  socket: Socket,
  parse: (data: Buffer) => { status: "more" } | T,
  { timeoutMs = 10_000, maxBytes = 32 * 1024 }: PeekOptions = {},
): Promise<{ result: T; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    const finish = (error: Error | null, result?: T) => {
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("error", onError)
      socket.off("end", onEnd)
      socket.pause()

      if (error) {
        reject(error)
      } else {
        resolve({ result: result as T, head: Buffer.concat(chunks, total) })
      }
    }

    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.byteLength
      const result = parse(Buffer.concat(chunks, total))

      if ((result as { status?: string }).status !== "more") {
        finish(null, result as T)
      } else if (total >= maxBytes) {
        finish(new Error("Too much data before the connection said where"))
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

/** A fatal TLS alert, unrecognized_name, for a name nobody here serves. */
export const UNRECOGNIZED_NAME_ALERT = Buffer.from([
  0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70,
])
