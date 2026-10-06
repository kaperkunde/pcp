// A copy of tunnel/protocol/frames.ts in kaperkunde/pcp-gg: keep the two the same.

/**
 * The tunnel's wire format. A connector holds one WebSocket to the relay;
 * every connection an assistant makes to the connector's name rides it as a
 * stream. Binary WebSocket messages are stream frames:
 *
 *   byte 0      frame type
 *   bytes 1..4  stream id, unsigned 32-bit big-endian (never 0)
 *   bytes 5..   payload
 *
 * Text WebSocket messages are the control channel (control.ts).
 *
 * The bytes in a DATA frame are whatever the assistant sent: for the HTTPS
 * port that is a TLS session the relay never decrypts, because the key that
 * would decrypt it exists only on the owner's computer.
 */

export const FrameType = {
  /** Relay → connector: a new connection. Payload: JSON OpenMeta. */
  Open: 1,
  /** Either way: bytes of the connection. */
  Data: 2,
  /** Either way: the sender will send no more bytes (a half-close). */
  End: 3,
  /** Either way: the stream is torn down. Payload: optional UTF-8 reason. */
  Reset: 4,
  /** Either way: the receiver has made room for this many more bytes. */
  Window: 5,
} as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

const FRAME_TYPES = new Set<number>(Object.values(FrameType))

/** Which of the connector's local ports a stream is for. */
export type TunnelPort = "https" | "http"

export type OpenMeta = {
  port: TunnelPort
}

export const HEADER_BYTES = 5
/** The most bytes one DATA frame carries. */
export const MAX_FRAME_PAYLOAD = 32 * 1024
/** Bytes either side may send on a stream before the other grants more. */
export const INITIAL_WINDOW = 256 * 1024
/** Streams one tunnel carries at once. */
export const MAX_STREAMS = 256
const MAX_META_BYTES = 1024
const MAX_REASON_BYTES = 256

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolError"
  }
}

export type Frame = {
  type: FrameType
  id: number
  payload: Uint8Array
}

export function encodeFrame(
  type: FrameType,
  id: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) {
    throw new RangeError(`Invalid stream id ${id}`)
  }

  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint8(0, type)
  view.setUint32(1, id)
  frame.set(payload, HEADER_BYTES)
  return frame
}

export function decodeFrame(data: Uint8Array): Frame {
  if (data.byteLength < HEADER_BYTES) {
    throw new ProtocolError("Frame shorter than its header")
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const type = view.getUint8(0)
  const id = view.getUint32(1)

  if (!FRAME_TYPES.has(type)) {
    throw new ProtocolError(`Unknown frame type ${type}`)
  }

  if (id === 0) {
    throw new ProtocolError("Stream id 0 is reserved")
  }

  const payload = data.subarray(HEADER_BYTES)

  if (type === FrameType.Data && payload.byteLength > MAX_FRAME_PAYLOAD) {
    throw new ProtocolError("DATA frame over the size limit")
  }

  return { type: type as FrameType, id, payload }
}

export function encodeOpenMeta(meta: OpenMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta))
}

export function decodeOpenMeta(payload: Uint8Array): OpenMeta {
  if (payload.byteLength > MAX_META_BYTES) {
    throw new ProtocolError("OPEN metadata too long")
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(new TextDecoder().decode(payload))
  } catch {
    throw new ProtocolError("OPEN metadata is not JSON")
  }

  const port = (parsed as { port?: unknown } | null)?.port

  if (port !== "https" && port !== "http") {
    throw new ProtocolError("OPEN metadata names no known port")
  }

  return { port }
}

export function encodeWindow(bytes: number): Uint8Array {
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, bytes)
  return payload
}

export function decodeWindow(payload: Uint8Array): number {
  if (payload.byteLength !== 4) {
    throw new ProtocolError("WINDOW frame payload must be 4 bytes")
  }

  const bytes = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(0)

  if (bytes === 0) {
    throw new ProtocolError("WINDOW frame grants nothing")
  }

  return bytes
}

export function encodeReason(reason: string): Uint8Array {
  const bytes = new TextEncoder().encode(reason)
  return bytes.subarray(0, MAX_REASON_BYTES)
}

export function decodeReason(payload: Uint8Array): string {
  return new TextDecoder().decode(payload.subarray(0, MAX_REASON_BYTES))
}
