import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import { buffer } from "node:stream/consumers"
import { Writable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { describe, expect, it } from "vitest"

import { CryptoError, generateDek } from "../crypto"
import {
  CHUNK_BYTES,
  chunkCount,
  decryptStream,
  encryptStream,
  HEADER_BYTES,
  nameKeyOf,
  newKey,
  newObjectId,
  openBuffer,
  plainSize,
  sealBuffer,
  sealedRange,
  sealedSize,
  unwrapFileKey,
  unwrapStoreKey,
  wrapFileKey,
  wrapStoreKey,
} from "./crypt"

// The encryption of an encrypted store: keys wrapped in turn, files sealed
// in chunks that stream, ranges read by their chunks, and every way of
// changing what is stored refused.

const SIZES: number[] = [
  0,
  1,
  CHUNK_BYTES - 1,
  CHUNK_BYTES,
  CHUNK_BYTES + 1,
  3 * CHUNK_BYTES,
  3 * CHUNK_BYTES + 17,
]

/** Somewhere for what a stream opens to go, read or not. */
const sink = () =>
  new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })

async function seal(key: Buffer, id: string, plain: Buffer): Promise<Buffer> {
  // In odd pieces, as a network hands them over.
  const pieces: Buffer[] = []
  for (let at = 0; at < plain.length; at += 10_007) {
    pieces.push(plain.subarray(at, at + 10_007))
  }
  return buffer(Readable.from(pieces).pipe(encryptStream(key, id)))
}

async function open(
  key: Buffer,
  id: string,
  sealed: Buffer,
  size: number,
  offset = 0,
  length = size - offset,
): Promise<Buffer> {
  const range = sealedRange(size, offset, length)
  const out: Buffer[] = []
  const decrypt = decryptStream(key, id, { size, offset, length })
  const source = sealed.subarray(range.start, range.end)
  const pieces: Buffer[] = []
  for (let at = 0; at < source.length; at += 9_973) {
    pieces.push(source.subarray(at, at + 9_973))
  }
  await pipeline(
    Readable.from(pieces),
    decrypt,
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        out.push(chunk)
        done()
      },
    }),
  )
  return Buffer.concat(out)
}

describe("store and file keys", () => {
  it("wrap under the vault key and the store key, bound to where they are", () => {
    const dek = generateDek()
    const storeKey = newKey()
    const wrapped = wrapStoreKey(dek, "store-1", storeKey)

    expect(unwrapStoreKey(dek, "store-1", wrapped)).toEqual(storeKey)
    expect(() => unwrapStoreKey(dek, "store-2", wrapped)).toThrow(CryptoError)
    expect(() => unwrapStoreKey(generateDek(), "store-1", wrapped)).toThrow(
      CryptoError,
    )

    const fileKey = newKey()
    const object = newObjectId()
    const file = wrapFileKey(storeKey, "store-1", object, fileKey)

    expect(unwrapFileKey(storeKey, "store-1", object, file)).toEqual(fileKey)
    expect(() =>
      unwrapFileKey(storeKey, "store-1", newObjectId(), file),
    ).toThrow(CryptoError)
    expect(() => unwrapFileKey(storeKey, "store-2", object, file)).toThrow(
      CryptoError,
    )
  })

  it("hash a name per folder and per store", () => {
    const key = newKey()

    expect(nameKeyOf(key, "", "a.pdf")).toBe(nameKeyOf(key, "", "a.pdf"))
    expect(nameKeyOf(key, "", "a.pdf")).not.toBe(nameKeyOf(key, "x", "a.pdf"))
    expect(nameKeyOf(key, "", "a.pdf")).not.toBe(nameKeyOf(key, "", "A.pdf"))
    expect(nameKeyOf(key, "", "a.pdf")).not.toBe(
      nameKeyOf(newKey(), "", "a.pdf"),
    )
  })
})

describe("sealed files", () => {
  it("stream in and out whole, at every size around a chunk", async () => {
    for (const size of SIZES) {
      const key = newKey()
      const id = newObjectId()
      const plain = randomBytes(size)
      const sealed = await seal(key, id, plain)

      expect(sealed.length, String(size)).toBe(sealedSize(size))
      expect(plainSize(sealed.length), String(size)).toBe(size)
      // Buffers compared as bytes: toEqual walks them one by one.
      expect(sealed.equals(sealBuffer(key, id, plain))).toBe(true)
      expect((await open(key, id, sealed, size)).equals(plain)).toBe(true)
      expect(openBuffer(key, id, sealed, size).equals(plain)).toBe(true)
    }
  })

  it("read a range from only the chunks it covers", async () => {
    const size = 5 * CHUNK_BYTES + 123
    const key = newKey()
    const id = newObjectId()
    const plain = randomBytes(size)
    const sealed = sealBuffer(key, id, plain)

    for (const [offset, length] of [
      [0, 10],
      [CHUNK_BYTES - 5, 10],
      [2 * CHUNK_BYTES, CHUNK_BYTES],
      [3 * CHUNK_BYTES + 7, 2 * CHUNK_BYTES],
      [size - 1, 1],
      [size - 50, 500],
      [size, 10],
    ] as const) {
      const read = await open(key, id, sealed, size, offset, length)
      expect(read.equals(plain.subarray(offset, offset + length))).toBe(true)
    }

    const range = sealedRange(size, 2 * CHUNK_BYTES + 1, 10)
    expect(range.firstChunk).toBe(2)
    expect(range.lastChunk).toBe(2)
    expect(range.end - range.start).toBe(CHUNK_BYTES + 16)
  })

  it("refuse a changed byte, the wrong key or another object's id", async () => {
    const size = 2 * CHUNK_BYTES + 9
    const key = newKey()
    const id = newObjectId()
    const sealed = sealBuffer(key, id, randomBytes(size))
    const changed = Buffer.from(sealed)
    changed[HEADER_BYTES + CHUNK_BYTES + 40]! ^= 1

    await expect(open(key, id, changed, size)).rejects.toThrow(CryptoError)
    await expect(open(newKey(), id, sealed, size)).rejects.toThrow(CryptoError)
    await expect(open(key, newObjectId(), sealed, size)).rejects.toThrow(
      CryptoError,
    )
  })

  it("refuse chunks swapped, cut off or followed by more", async () => {
    const size = 3 * CHUNK_BYTES
    const key = newKey()
    const id = newObjectId()
    const sealed = sealBuffer(key, id, randomBytes(size))
    const chunk = (index: number) =>
      sealed.subarray(
        HEADER_BYTES + index * (CHUNK_BYTES + 16),
        HEADER_BYTES + (index + 1) * (CHUNK_BYTES + 16),
      )
    const header = sealed.subarray(0, HEADER_BYTES)

    const swapped = Buffer.concat([header, chunk(1), chunk(0), chunk(2)])
    await expect(open(key, id, swapped, size)).rejects.toThrow(CryptoError)

    // Cut at a chunk's end: the chunk that is last now was not sealed last.
    const cut = Buffer.concat([header, chunk(0), chunk(1)])
    await expect(open(key, id, cut, 2 * CHUNK_BYTES)).rejects.toThrow(
      CryptoError,
    )
    expect(() => openBuffer(key, id, cut, 2 * CHUNK_BYTES)).toThrow(CryptoError)

    // Shorter than the file is: refused at the end.
    await expect(
      pipeline(
        Readable.from([sealed.subarray(0, sealed.length - 1)]),
        decryptStream(key, id, { size }),
        sink(),
      ),
    ).rejects.toThrow(CryptoError)

    // More after the last chunk.
    await expect(
      pipeline(
        Readable.from([Buffer.concat([sealed, Buffer.from([0])])]),
        decryptStream(key, id, { size }),
        sink(),
      ),
    ).rejects.toThrow(CryptoError)

    // A chunk of another object with the same key and index is refused too.
    const other = sealBuffer(key, newObjectId(), randomBytes(size))
    const mixed = Buffer.concat([
      header,
      chunk(0),
      other.subarray(
        HEADER_BYTES + (CHUNK_BYTES + 16),
        HEADER_BYTES + 2 * (CHUNK_BYTES + 16),
      ),
      chunk(2),
    ])
    await expect(open(key, id, mixed, size)).rejects.toThrow(CryptoError)
  })

  it("count chunks and sealed sizes", () => {
    expect(chunkCount(0)).toBe(1)
    expect(chunkCount(CHUNK_BYTES)).toBe(1)
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2)
    expect(plainSize(3)).toBeNull()
    expect(plainSize(sealedSize(CHUNK_BYTES) + 1)).toBeNull()
  })
})
