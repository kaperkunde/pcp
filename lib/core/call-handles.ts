import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto"

import { canonicalJson } from "./permission-rules"

/**
 * Call handles: what describe_tool hands an assistant and call_tool takes in
 * place of a server and a tool name, so a tool is always described before
 * it is called. A handle is stateless (/mcp keeps no session): it names the
 * tool's catalogue row and carries two MACs under a key derived from the
 * vault's data key, so it cannot be made without the key, works for the
 * token it was made for only, and goes stale when the tool's schema
 * changes.
 *
 *   ch_<tool ref>_<tag>
 *
 * - the tool ref is the McpTool row's id, base32: opaque, never a name;
 * - the tag is an identity MAC (token, server, tool, ref and the start of
 *   the schema's hash: the handle is genuine), that start of the hash, and
 *   a call MAC (the same, with the whole hash of the tool's canonical
 *   inputSchema: it is current). A genuine handle whose schema hash no
 *   longer starts the same was made for an older schema; one whose start
 *   still matches but whose call MAC does not was changed.
 *
 * Nothing here reads the database; the gateway looks the row up.
 */

const KEY_LABEL = "pcp call handle v1"
/** The identity MAC: enough to tell a stale handle from a made-up one. */
const IDENTITY_BYTES = 10
/** The start of the schema's hash the handle was made for, in the clear. */
const SCHEMA_BYTES = 6
/** The call MAC, over the schema too: 128 bits. */
const CALL_BYTES = 16
const TAG_BYTES = IDENTITY_BYTES + SCHEMA_BYTES + CALL_BYTES
const PREFIX = "ch_"
/** A ref that is not a UUID's 16 bytes: its UTF-8 text, after this mark. */
const TEXT_REF = "0"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** RFC 4648 base32, lowercase, without padding. */
export function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8

    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31]
  }

  return out
}

/** The bytes of lowercase unpadded base32, or null when it is not that. */
export function fromBase32(text: string): Buffer | null {
  const bytes: number[] = []
  let bits = 0
  let value = 0

  for (const char of text) {
    const digit = ALPHABET.indexOf(char)

    if (digit < 0) {
      return null
    }

    value = ((value << 5) | digit) & 0xffff
    bits += 5

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }

  // Leftover bits are padding and must be zero, or two texts would decode
  // to the same bytes.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) {
    return null
  }

  return Buffer.from(bytes)
}

function encodeRef(toolId: string): string {
  return UUID.test(toolId)
    ? base32(Buffer.from(toolId.replace(/-/g, ""), "hex"))
    : `${TEXT_REF}${base32(Buffer.from(toolId, "utf8"))}`
}

function decodeRef(ref: string): string | null {
  if (ref.startsWith(TEXT_REF)) {
    const bytes = fromBase32(ref.slice(TEXT_REF.length))
    return bytes && bytes.length > 0 && bytes.length <= 64
      ? bytes.toString("utf8")
      : null
  }

  const bytes = fromBase32(ref)

  if (!bytes || bytes.length !== 16) {
    return null
  }

  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The key handles are made with: the vault's, never stored. */
function handleKey(dek: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), KEY_LABEL, 32))
}

/** The hash of a stored inputSchema (JSON text), key order aside. */
export function schemaHash(inputSchema: string): Buffer {
  let canonical: string

  try {
    canonical = canonicalJson(JSON.parse(inputSchema))
  } catch {
    canonical = inputSchema
  }

  return createHash("sha256").update(canonical).digest()
}

export type HandleTarget = {
  tokenId: string
  serverId: string
  /** The McpTool row's id. */
  toolId: string
  /** The tool's name. */
  tool: string
  /** The tool's inputSchema as stored (JSON text). */
  inputSchema: string
}

function mac(key: Buffer, parts: string[], bytes: number): Buffer {
  return createHmac("sha256", key)
    .update(parts.join("\n"))
    .digest()
    .subarray(0, bytes)
}

function who(target: HandleTarget): string[] {
  return [target.tokenId, target.serverId, target.tool, target.toolId]
}

function identityMac(key: Buffer, target: HandleTarget, schema: Buffer) {
  return mac(
    key,
    ["identity", ...who(target), schema.toString("hex")],
    IDENTITY_BYTES,
  )
}

export function makeCallHandle(dek: Buffer, target: HandleTarget): string {
  const key = handleKey(dek)
  const hash = schemaHash(target.inputSchema)
  const start = hash.subarray(0, SCHEMA_BYTES)
  const tag = Buffer.concat([
    identityMac(key, target, start),
    start,
    mac(key, ["call", ...who(target), hash.toString("hex")], CALL_BYTES),
  ])

  return `${PREFIX}${encodeRef(target.toolId)}_${base32(tag)}`
}

export type ParsedHandle = { toolId: string; tag: Buffer }

/** The row a handle names, or null when the text is not a handle at all. */
export function parseCallHandle(text: string): ParsedHandle | null {
  const value = text.trim()

  if (!value.startsWith(PREFIX) || value.length > 200) {
    return null
  }

  const parts = value.slice(PREFIX.length).split("_")

  if (parts.length !== 2) {
    return null
  }

  const toolId = decodeRef(parts[0]!)
  const tag = fromBase32(parts[1]!)

  if (!toolId || !tag || tag.length !== TAG_BYTES) {
    return null
  }

  return { toolId, tag }
}

/**
 * What a parsed handle is for the tool as it is now: "current" when it was
 * made for this schema, "stale" when it is genuine but was made for another
 * schema, "invalid" when it was not made by PCP for this token and tool, or
 * was changed since.
 */
export function checkCallHandle(
  dek: Buffer,
  parsed: ParsedHandle,
  target: HandleTarget,
): "current" | "stale" | "invalid" {
  const key = handleKey(dek)
  const identity = parsed.tag.subarray(0, IDENTITY_BYTES)
  const start = parsed.tag.subarray(
    IDENTITY_BYTES,
    IDENTITY_BYTES + SCHEMA_BYTES,
  )
  const call = parsed.tag.subarray(IDENTITY_BYTES + SCHEMA_BYTES)

  if (
    parsed.toolId !== target.toolId ||
    !timingSafeEqual(identity, identityMac(key, target, start))
  ) {
    return "invalid"
  }

  const hash = schemaHash(target.inputSchema)

  if (!timingSafeEqual(start, hash.subarray(0, SCHEMA_BYTES))) {
    return "stale"
  }

  return timingSafeEqual(
    call,
    mac(key, ["call", ...who(target), hash.toString("hex")], CALL_BYTES),
  )
    ? "current"
    : "invalid"
}
