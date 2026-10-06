// A copy of tunnel/protocol/mux.ts in kaperkunde/pcp-gg: keep the two the same.

import { Duplex } from "node:stream"

import {
  decodeFrame,
  decodeOpenMeta,
  decodeReason,
  decodeWindow,
  encodeFrame,
  encodeOpenMeta,
  encodeReason,
  encodeWindow,
  FrameType,
  INITIAL_WINDOW,
  MAX_FRAME_PAYLOAD,
  MAX_STREAMS,
  type OpenMeta,
  ProtocolError,
} from "./frames"

/**
 * Many connections over one WebSocket. The relay opens a stream for every
 * connection it accepts for a name; the connector answers each by dialling
 * PCP on its own computer. Each direction of each stream has a window, so a
 * slow reader on one connection holds up only that connection, and neither
 * side buffers more than a window per stream.
 */

export type Transport = {
  send(frame: Uint8Array): void
  /** Bytes the transport has queued but not yet written to the network. */
  bufferedAmount(): number
}

export type MuxOptions = {
  /** Only the opener sends OPEN; the other side only accepts. */
  role: "opener" | "acceptor"
  onStream?: (stream: MuxStream, meta: OpenMeta) => void
  maxStreams?: number
  initialWindow?: number
}

/** How full the transport's own buffer may get before writers wait. */
const TRANSPORT_HIGH_WATER = 1024 * 1024
const TRANSPORT_POLL_MS = 5
/** A peer that grants more than this has lost count. */
const MAX_SEND_WINDOW = 64 * 1024 * 1024

export class StreamLimitError extends Error {
  constructor() {
    super("Too many connections at once")
    this.name = "StreamLimitError"
  }
}

export class StreamResetError extends Error {
  constructor(reason: string) {
    super(reason || "Connection reset by the other side")
    this.name = "StreamResetError"
  }
}

type StreamLink = {
  send(type: FrameType, payload?: Uint8Array): void
  transportReady(): Promise<void>
  forget(): void
  isClosed(): boolean
}

export class Mux {
  readonly #transport: Transport
  readonly #role: MuxOptions["role"]
  readonly #onStream: MuxOptions["onStream"]
  readonly #maxStreams: number
  readonly #initialWindow: number
  readonly #streams = new Map<number, MuxStream>()
  #nextId = 1
  #closed = false

  constructor(transport: Transport, options: MuxOptions) {
    this.#transport = transport
    this.#role = options.role
    this.#onStream = options.onStream
    this.#maxStreams = options.maxStreams ?? MAX_STREAMS
    this.#initialWindow = options.initialWindow ?? INITIAL_WINDOW
  }

  get size(): number {
    return this.#streams.size
  }

  get closed(): boolean {
    return this.#closed
  }

  open(meta: OpenMeta): MuxStream {
    if (this.#role !== "opener") {
      throw new Error("Only the relay opens streams")
    }

    if (this.#closed) {
      throw new Error("Tunnel is closed")
    }

    if (this.#streams.size >= this.#maxStreams) {
      throw new StreamLimitError()
    }

    const id = this.#nextId
    this.#nextId = id >= 0xffffffff ? 1 : id + 1
    const stream = this.#create(id)
    this.#send(FrameType.Open, id, encodeOpenMeta(meta))
    return stream
  }

  /**
   * One binary message from the peer. Throws ProtocolError when the peer
   * broke the protocol; the caller then closes the whole tunnel.
   */
  receive(data: Uint8Array): void {
    if (this.#closed) {
      return
    }

    const { type, id, payload } = decodeFrame(data)

    if (type === FrameType.Open) {
      this.#receiveOpen(id, payload)
      return
    }

    // A frame for a stream that is gone is one that crossed our RESET.
    const stream = this.#streams.get(id)

    if (!stream) {
      return
    }

    switch (type) {
      case FrameType.Data:
        stream._receiveData(payload)
        break
      case FrameType.End:
        stream._receiveEnd()
        break
      case FrameType.Reset:
        stream._receiveReset(decodeReason(payload))
        break
      case FrameType.Window:
        stream._receiveWindow(decodeWindow(payload))
        break
    }
  }

  /** Ends every stream: the WebSocket under it has gone. */
  close(reason = "Tunnel closed"): void {
    if (this.#closed) {
      return
    }

    this.#closed = true

    for (const stream of [...this.#streams.values()]) {
      stream.destroy(new StreamResetError(reason))
    }

    this.#streams.clear()
  }

  #receiveOpen(id: number, payload: Uint8Array): void {
    if (this.#role === "opener") {
      throw new ProtocolError("The connector may not open streams")
    }

    if (this.#streams.has(id)) {
      throw new ProtocolError(`Stream ${id} is already open`)
    }

    const meta = decodeOpenMeta(payload)

    if (this.#streams.size >= this.#maxStreams || !this.#onStream) {
      this.#send(FrameType.Reset, id, encodeReason("Too many connections"))
      return
    }

    this.#onStream(this.#create(id), meta)
  }

  #create(id: number): MuxStream {
    const link: StreamLink = {
      send: (type, payload) => this.#send(type, id, payload),
      transportReady: () => this.#transportReady(),
      forget: () => {
        if (this.#streams.get(id) === stream) {
          this.#streams.delete(id)
        }
      },
      isClosed: () => this.#closed,
    }
    const stream = new MuxStream(id, link, this.#initialWindow)
    this.#streams.set(id, stream)
    return stream
  }

  #send(type: FrameType, id: number, payload?: Uint8Array): void {
    if (!this.#closed) {
      this.#transport.send(encodeFrame(type, id, payload))
    }
  }

  async #transportReady(): Promise<void> {
    while (
      !this.#closed &&
      this.#transport.bufferedAmount() > TRANSPORT_HIGH_WATER
    ) {
      await new Promise((resolve) => setTimeout(resolve, TRANSPORT_POLL_MS))
    }

    if (this.#closed) {
      throw new StreamResetError("Tunnel closed")
    }
  }
}

export class MuxStream extends Duplex {
  readonly id: number
  readonly #link: StreamLink
  readonly #initialWindow: number
  #sendWindow: number
  #windowWaiter: (() => void) | null = null
  /** Bytes received since we last granted the peer room for more. */
  #ungranted = 0
  #endSent = false
  #endReceived = false
  #resetReceived = false

  constructor(id: number, link: StreamLink, initialWindow: number) {
    super({ allowHalfOpen: true, readableHighWaterMark: 64 * 1024 })
    this.id = id
    this.#link = link
    this.#initialWindow = initialWindow
    this.#sendWindow = initialWindow
  }

  _receiveData(payload: Uint8Array): void {
    if (this.#endReceived) {
      this.destroy(new ProtocolError("DATA after END"))
      return
    }

    this.#ungranted += payload.byteLength

    if (this.#ungranted > this.#initialWindow) {
      this.destroy(new ProtocolError("Peer sent more than its window"))
      return
    }

    const roomForMore = this.push(
      Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
    )

    if (roomForMore) {
      this.#grant()
    }
  }

  _receiveEnd(): void {
    if (!this.#endReceived) {
      this.#endReceived = true
      this.push(null)
    }
  }

  _receiveReset(reason: string): void {
    this.#resetReceived = true
    this.destroy(new StreamResetError(reason))
  }

  _receiveWindow(bytes: number): void {
    this.#sendWindow += bytes

    if (this.#sendWindow > MAX_SEND_WINDOW) {
      this.destroy(new ProtocolError("Peer granted an impossible window"))
      return
    }

    this.#wake()
  }

  override _read(): void {
    this.#grant()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#writeAll(chunk).then(
      () => callback(),
      (error: Error) => callback(this.destroyed ? null : error),
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#endSent = true
    this.#link.send(FrameType.End)
    callback()
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#link.forget()
    this.#wake()

    const finishedCleanly = this.#endSent && this.#endReceived

    if (!this.#resetReceived && !finishedCleanly && !this.#link.isClosed()) {
      this.#link.send(FrameType.Reset, encodeReason(error?.message ?? ""))
    }

    callback(error)
  }

  async #writeAll(chunk: Buffer): Promise<void> {
    let offset = 0

    while (offset < chunk.byteLength) {
      while (this.#sendWindow <= 0 && !this.destroyed) {
        await new Promise<void>((resolve) => {
          this.#windowWaiter = resolve
        })
      }

      if (this.destroyed) {
        throw new StreamResetError("Connection closed")
      }

      await this.#link.transportReady()

      const size = Math.min(
        this.#sendWindow,
        MAX_FRAME_PAYLOAD,
        chunk.byteLength - offset,
      )
      this.#link.send(FrameType.Data, chunk.subarray(offset, offset + size))
      this.#sendWindow -= size
      offset += size
    }
  }

  /**
   * Gives the peer back the room the bytes we have passed on took. Small
   * amounts wait for more, so a busy stream is not one WINDOW per DATA.
   */
  #grant(): void {
    if (
      this.#ungranted > 0 &&
      !this.destroyed &&
      (this.#ungranted >= this.#initialWindow / 4 || this.readableLength === 0)
    ) {
      this.#link.send(FrameType.Window, encodeWindow(this.#ungranted))
      this.#ungranted = 0
    }
  }

  #wake(): void {
    const waiter = this.#windowWaiter
    this.#windowWaiter = null
    waiter?.()
  }
}

/**
 * Joins two connections, each direction ending the other's when it ends. A
 * side that fails or closes before finishing takes the other down with it.
 */
export function bridge(a: Duplex, b: Duplex): void {
  a.pipe(b)
  b.pipe(a)

  const watch = (self: Duplex, other: Duplex) => {
    self.on("error", () => other.destroy())
    self.on("close", () => {
      if (!self.readableEnded || !self.writableFinished) {
        other.destroy()
      }
    })
  }

  watch(a, b)
  watch(b, a)
}
