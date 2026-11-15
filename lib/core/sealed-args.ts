import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"

import { decrypt, encrypt } from "./crypto"

/**
 * A permission request's arguments, sealed. Most are a few hundred bytes;
 * one that holds a whole API schema (register_server with the OpenAPI text,
 * #141) can be 14 MB, which every page view of the request would otherwise
 * decrypt at that size and the database would hold at it. From 64 KB the
 * JSON is Brotli-compressed before it is encrypted, marked by a leading NUL
 * byte that JSON text never starts with, so a request from before (plain
 * JSON) opens as it always did.
 */

const PACK_FROM_BYTES = 64 * 1024
const PACKED = 0

export function sealArgs(dek: Buffer, args: unknown, aad: string): Buffer {
  const json = Buffer.from(JSON.stringify(args), "utf8")

  if (json.length < PACK_FROM_BYTES) {
    return encrypt(dek, json, aad)
  }

  const packed = brotliCompressSync(json, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  })

  return encrypt(dek, Buffer.concat([Buffer.from([PACKED]), packed]), aad)
}

export function openArgs<T = Record<string, unknown>>(
  dek: Buffer,
  blob: Buffer,
  aad: string,
): T {
  const plain = decrypt(dek, blob, aad)

  if (plain[0] === PACKED) {
    return JSON.parse(
      brotliDecompressSync(plain.subarray(1), {
        maxOutputLength: 1024 * 1024 * 1024,
      }).toString("utf8"),
    ) as T
  }

  return JSON.parse(plain.toString("utf8")) as T
}
