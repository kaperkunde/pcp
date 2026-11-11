import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto"
import { Transform, type TransformCallback } from "node:stream"

import { CryptoError, decrypt, encrypt } from "../crypto"

/**
 * The encryption of an encrypted store (lib/core/storage/), pure: no
 * database, no file system, no key read from anywhere but the arguments.
 *
 * Keys. A store has a key of its own, random, wrapped under the vault key
 * with the store's id as associated data (`storage_store:<id>`). Each file
 * (each version of one: a file written again gets a new key) has a random
 * key wrapped under the store key, bound to the store and the object's id
 * (`storage_object:<storeId>:<objectId>`), so a wrapped key moved to another
 * object or store does not open.
 *
 * Content. An object is a short header and then the file in chunks of
 * CHUNK_BYTES, each sealed on its own with AES-256-GCM under the file key:
 * the nonce is the chunk's index, and the associated data the object's id,
 * the index and whether it is the last chunk. So a large file streams in
 * and out a chunk at a time, a range is read by opening only the chunks it
 * covers, and a chunk swapped with another (of this object or any other),
 * moved, repeated, cut off or followed by more is refused. Every chunk but
 * the last is full; an empty file is one empty last chunk.
 *
 * The file key is never used twice for different content (a write makes a
 * new one), which is what lets the nonce be the chunk's index.
 */

export const KEY_BYTES = 32
/** Plaintext in each chunk but the last. */
export const CHUNK_BYTES = 64 * 1024
const TAG_BYTES = 16
const NONCE_BYTES = 12
/** "PCPS", format 1, three bytes kept zero. */
export const HEADER = Buffer.from([0x50, 0x43, 0x50, 0x53, 1, 0, 0, 0])
export const HEADER_BYTES = HEADER.length
const SEALED_CHUNK_BYTES = CHUNK_BYTES + TAG_BYTES

/** A new random key: a store's or a file's. */
export function newKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** A new object id: random, so a name never shows on the backend. */
export function newObjectId(): string {
  return randomBytes(16).toString("hex")
}

export const OBJECT_ID = /^[0-9a-f]{32}$/

export function storeKeyAad(storeId: string): string {
  return `storage_store:${storeId}`
}

export function fileKeyAad(storeId: string, objectId: string): string {
  return `storage_object:${storeId}:${objectId}`
}

export function wrapStoreKey(
  dek: Buffer,
  storeId: string,
  key: Buffer,
): Buffer {
  return encrypt(dek, key, storeKeyAad(storeId))
}

export function unwrapStoreKey(
  dek: Buffer,
  storeId: string,
  wrapped: Uint8Array,
): Buffer {
  return checkedKey(decrypt(dek, Buffer.from(wrapped), storeKeyAad(storeId)))
}

export function wrapFileKey(
  storeKey: Buffer,
  storeId: string,
  objectId: string,
  key: Buffer,
): Buffer {
  return encrypt(storeKey, key, fileKeyAad(storeId, objectId))
}

export function unwrapFileKey(
  storeKey: Buffer,
  storeId: string,
  objectId: string,
  wrapped: Uint8Array,
): Buffer {
  return checkedKey(
    decrypt(storeKey, Buffer.from(wrapped), fileKeyAad(storeId, objectId)),
  )
}

function checkedKey(key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError("a wrapped key is not 32 bytes")
  }
  return key
}

/**
 * A keyed hash of a name in its folder, for the index to find and keep
 * unique without holding the name in the clear. Its key is derived from the
 * store key, so it says nothing across stores.
 */
export function nameKeyOf(
  storeKey: Buffer,
  parentId: string,
  name: string,
): string {
  const key = Buffer.from(
    hkdfSync("sha256", storeKey, Buffer.alloc(0), "pcp store names", 32),
  )
  return createHmac("sha256", key)
    .update(parentId)
    .update("\u0000")
    .update(name, "utf8")
    .digest("hex")
    .slice(0, 40)
}

/** How many chunks a file of `size` bytes is sealed in: at least one. */
export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_BYTES))
}

/** The size of the sealed object for a file of `size` bytes. */
export function sealedSize(size: number): number {
  return HEADER_BYTES + size + chunkCount(size) * TAG_BYTES
}

/**
 * The file's size from its sealed object's, or null when no file seals to
 * that many bytes.
 */
export function plainSize(sealed: number): number | null {
  if (sealed < HEADER_BYTES + TAG_BYTES) return null
  const chunks = Math.ceil((sealed - HEADER_BYTES) / SEALED_CHUNK_BYTES)
  const size = sealed - HEADER_BYTES - chunks * TAG_BYTES
  return size >= 0 && sealedSize(size) === sealed ? size : null
}

export type SealedRange = {
  /** The sealed bytes to read: from `start`, up to but not at `end`. */
  start: number
  end: number
  firstChunk: number
  lastChunk: number
  /** The plaintext asked for, clamped to the file. */
  offset: number
  length: number
}

/**
 * Which sealed bytes hold `length` bytes of the file from `offset`: only
 * the chunks they fall in. Past the end, a range is cut to the file.
 */
export function sealedRange(
  size: number,
  offset = 0,
  length = size - offset,
): SealedRange {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CryptoError("a range starts at a whole number of bytes")
  }

  const from = Math.min(offset, size)
  const until = Math.min(size, from + Math.max(0, length))
  const total = chunkCount(size)
  const firstChunk = Math.min(Math.floor(from / CHUNK_BYTES), total - 1)
  const lastChunk =
    until > from
      ? Math.min(Math.floor((until - 1) / CHUNK_BYTES), total - 1)
      : firstChunk

  return {
    // From the first chunk, the header too, which is checked.
    start:
      firstChunk === 0 ? 0 : HEADER_BYTES + firstChunk * SEALED_CHUNK_BYTES,
    end: Math.min(
      sealedSize(size),
      HEADER_BYTES + (lastChunk + 1) * SEALED_CHUNK_BYTES,
    ),
    firstChunk,
    lastChunk,
    offset: from,
    length: until - from,
  }
}

function nonceOf(index: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES)
  nonce.writeBigUInt64BE(BigInt(index), 4)
  return nonce
}

function chunkAad(objectId: string, index: number, final: boolean): Buffer {
  const id = Buffer.from(objectId, "utf8")
  const aad = Buffer.alloc(id.length + 1 + 8 + 1)
  id.copy(aad, 0)
  aad.writeBigUInt64BE(BigInt(index), id.length + 1)
  aad[aad.length - 1] = final ? 1 : 0
  return aad
}

/** One chunk sealed: ciphertext then tag. */
export function sealChunk(
  fileKey: Buffer,
  objectId: string,
  index: number,
  final: boolean,
  plain: Buffer,
): Buffer {
  if (plain.length > CHUNK_BYTES || (!final && plain.length !== CHUNK_BYTES)) {
    throw new CryptoError("a chunk is full unless it is the last")
  }

  const cipher = createCipheriv("aes-256-gcm", fileKey, nonceOf(index))
  cipher.setAAD(chunkAad(objectId, index, final))
  return Buffer.concat([
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

/** One chunk opened, or a CryptoError. */
export function openChunk(
  fileKey: Buffer,
  objectId: string,
  index: number,
  final: boolean,
  sealed: Buffer,
): Buffer {
  if (sealed.length < TAG_BYTES || sealed.length > SEALED_CHUNK_BYTES) {
    throw new CryptoError("a sealed chunk has the wrong length")
  }

  const decipher = createDecipheriv("aes-256-gcm", fileKey, nonceOf(index))
  decipher.setAAD(chunkAad(objectId, index, final))
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))

  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ])
  } catch {
    throw new CryptoError(
      "a stored file did not decrypt: it was changed, cut off or mixed with another",
    )
  }
}

/**
 * Seals a file as it streams in: the header, then each full chunk once the
 * next byte shows it is not the last, then the last at the end.
 */
export function encryptStream(fileKey: Buffer, objectId: string): Transform {
  let pending: Buffer[] = []
  let pendingBytes = 0
  let index = 0
  let headerSent = false

  const header = (stream: Transform) => {
    if (!headerSent) {
      headerSent = true
      stream.push(HEADER)
    }
  }

  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      try {
        header(this)
        pending.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        pendingBytes += chunk.length

        // A full chunk goes out only once more follows it.
        while (pendingBytes > CHUNK_BYTES) {
          const all = Buffer.concat(pending)
          this.push(
            sealChunk(
              fileKey,
              objectId,
              index++,
              false,
              all.subarray(0, CHUNK_BYTES),
            ),
          )
          const rest = all.subarray(CHUNK_BYTES)
          pending = [rest]
          pendingBytes = rest.length
        }
        done()
      } catch (error) {
        done(error as Error)
      }
    },
    flush(done: TransformCallback) {
      try {
        header(this)
        this.push(
          sealChunk(fileKey, objectId, index, true, Buffer.concat(pending)),
        )
        pending = []
        done()
      } catch (error) {
        done(error as Error)
      }
    },
  })
}

/**
 * Opens a range of a file as its sealed bytes stream in: the input is the
 * sealed object from `sealedRange(...).start` to `.end` (with the header
 * when the range starts at the first chunk), the output the plaintext from
 * `offset` for `length` bytes. Anything short of the chunks the range
 * covers, or more than them, is refused.
 */
export function decryptStream(
  fileKey: Buffer,
  objectId: string,
  {
    size,
    offset = 0,
    length,
  }: { size: number; offset?: number; length?: number },
): Transform {
  const range = sealedRange(size, offset, length ?? size - offset)
  const last = chunkCount(size) - 1
  let index = range.firstChunk
  let buffered: Buffer[] = []
  let bufferedBytes = 0
  let headerLeft = range.firstChunk === 0 ? HEADER_BYTES : 0
  let at = range.firstChunk * CHUNK_BYTES

  const want = (chunk: number) =>
    chunk === last ? size - chunk * CHUNK_BYTES + TAG_BYTES : SEALED_CHUNK_BYTES

  const emit = (stream: Transform, plain: Buffer) => {
    const from = Math.max(range.offset, at)
    const until = Math.min(range.offset + range.length, at + plain.length)

    if (until > from) {
      stream.push(plain.subarray(from - at, until - at))
    }
    at += plain.length
  }

  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      try {
        let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

        if (headerLeft > 0) {
          const head = data.subarray(0, headerLeft)
          const expected = HEADER.subarray(
            HEADER_BYTES - headerLeft,
            HEADER_BYTES - headerLeft + head.length,
          )

          if (!head.equals(expected)) {
            throw new CryptoError("a stored file is not in PCP's format")
          }

          headerLeft -= head.length
          data = data.subarray(head.length)
        }

        buffered.push(data)
        bufferedBytes += data.length

        while (index <= range.lastChunk && bufferedBytes >= want(index)) {
          const all = Buffer.concat(buffered)
          const sealed = all.subarray(0, want(index))
          emit(
            this,
            openChunk(fileKey, objectId, index, index === last, sealed),
          )
          index++
          const rest = all.subarray(sealed.length)
          buffered = [rest]
          bufferedBytes = rest.length
        }

        if (index > range.lastChunk && bufferedBytes > 0) {
          throw new CryptoError("a stored file has more than it should")
        }
        done()
      } catch (error) {
        done(error as Error)
      }
    },
    flush(done: TransformCallback) {
      if (headerLeft > 0 || index <= range.lastChunk || bufferedBytes > 0) {
        done(new CryptoError("a stored file was cut off"))
        return
      }
      done()
    },
  })
}

/** A whole file sealed at once, for small files and tests. */
export function sealBuffer(
  fileKey: Buffer,
  objectId: string,
  plain: Buffer,
): Buffer {
  const parts: Buffer[] = [HEADER]
  const total = chunkCount(plain.length)

  for (let index = 0; index < total; index++) {
    parts.push(
      sealChunk(
        fileKey,
        objectId,
        index,
        index === total - 1,
        plain.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
      ),
    )
  }

  return Buffer.concat(parts)
}

/** A whole sealed object opened at once, given the file's size. */
export function openBuffer(
  fileKey: Buffer,
  objectId: string,
  sealed: Buffer,
  size: number,
): Buffer {
  if (sealed.length !== sealedSize(size)) {
    throw new CryptoError("a stored file has the wrong length")
  }

  if (!sealed.subarray(0, HEADER_BYTES).equals(HEADER)) {
    throw new CryptoError("a stored file is not in PCP's format")
  }

  const total = chunkCount(size)
  const parts: Buffer[] = []
  let at = HEADER_BYTES

  for (let index = 0; index < total; index++) {
    const length =
      index === total - 1
        ? size - index * CHUNK_BYTES + TAG_BYTES
        : SEALED_CHUNK_BYTES
    parts.push(
      openChunk(
        fileKey,
        objectId,
        index,
        index === total - 1,
        sealed.subarray(at, at + length),
      ),
    )
    at += length
  }

  return Buffer.concat(parts)
}
