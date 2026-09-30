import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto"

/**
 * The cryptography behind the secret store.
 *
 * Every vault has one random 256-bit data encryption key (DEK). Values are
 * AES-256-GCM ciphertext under the DEK, with the row's own id as associated
 * data so a ciphertext cannot be moved to another row and still decrypt.
 *
 * The DEK is never written down in the clear. It is stored wrapped — itself
 * AES-256-GCM ciphertext — under a key encryption key (KEK) derived from a
 * credential the server does not keep:
 *
 * - the owner's password, through scrypt (slow on purpose: a stolen
 *   database can only be attacked one guess at a time);
 * - a random 256-bit secret, through HKDF (fast: the secret already has more
 *   entropy than the key). Session cookies, API tokens and the recovery key
 *   are this kind. The database keeps a SHA-256 of the secret to find the
 *   grant by, which is useless for unwrapping.
 *
 * So the server holds ciphertext and hashes; the key material arrives with
 * each request and is dropped when it ends. That is what makes the data at
 * rest unreadable to anyone who only has the disk.
 */

export const DEK_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CryptoError"
  }
}

export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES)
}

/** A random credential with 256 bits of entropy, URL-safe. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}

/**
 * A Buffer as the plain Uint8Array Prisma's Bytes columns take. Copies into
 * a fresh ArrayBuffer, which is also what keeps a slice of a pooled Buffer
 * from dragging its whole pool into the database driver.
 */
export function asBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(buffer.length))
  bytes.set(buffer)
  return bytes
}

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  if (left.length !== right.length) {
    return false
  }

  return timingSafeEqual(left, right)
}

/** nonce || ciphertext || tag */
export function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  if (key.length !== DEK_BYTES) {
    throw new CryptoError("key must be 32 bytes")
  }

  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()])
}

export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (key.length !== DEK_BYTES) {
    throw new CryptoError("key must be 32 bytes")
  }

  if (blob.length < NONCE_BYTES + TAG_BYTES) {
    throw new CryptoError("ciphertext is too short")
  }

  const nonce = blob.subarray(0, NONCE_BYTES)
  const tag = blob.subarray(blob.length - TAG_BYTES)
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES)
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAAD(Buffer.from(aad, "utf8"))
  decipher.setAuthTag(tag)

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new CryptoError("decryption failed: wrong key or corrupt data")
  }
}

export function encryptString(key: Buffer, value: string, aad: string): Buffer {
  return encrypt(key, Buffer.from(value, "utf8"), aad)
}

export function decryptString(key: Buffer, blob: Buffer, aad: string): string {
  return decrypt(key, blob, aad).toString("utf8")
}

// ---- Key encryption keys -------------------------------------------------

export type ScryptParams = {
  kdf: "scrypt"
  salt: string
  N: number
  r: number
  p: number
}

export type HkdfParams = {
  kdf: "hkdf"
  salt: string
}

export type KdfParams = ScryptParams | HkdfParams

const HKDF_INFO = "pcp-kek-v1"

/**
 * scrypt with 64 MiB of memory and a single lane: around a tenth of a second
 * on current hardware, which a person logging in does not notice and which
 * turns a leaked database into a very slow guessing game. Parameters are
 * stored with each grant, so they can be raised for new grants later.
 */
export function newScryptParams(): ScryptParams {
  return {
    kdf: "scrypt",
    salt: randomBytes(16).toString("base64"),
    N: 1 << 16,
    r: 8,
    p: 1,
  }
}

export function newHkdfParams(): HkdfParams {
  return { kdf: "hkdf", salt: randomBytes(16).toString("base64") }
}

export function parseKdfParams(json: string): KdfParams {
  const parsed = JSON.parse(json) as Record<string, unknown>

  if (parsed.kdf === "scrypt") {
    if (
      typeof parsed.salt !== "string" ||
      typeof parsed.N !== "number" ||
      typeof parsed.r !== "number" ||
      typeof parsed.p !== "number"
    ) {
      throw new CryptoError("invalid scrypt parameters")
    }

    return {
      kdf: "scrypt",
      salt: parsed.salt,
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    }
  }

  if (parsed.kdf === "hkdf") {
    if (typeof parsed.salt !== "string") {
      throw new CryptoError("invalid hkdf parameters")
    }

    return { kdf: "hkdf", salt: parsed.salt }
  }

  throw new CryptoError(`unknown kdf ${String(parsed.kdf)}`)
}

export async function deriveKek(
  credential: string,
  params: KdfParams,
): Promise<Buffer> {
  const salt = Buffer.from(params.salt, "base64")

  if (params.kdf === "hkdf") {
    return Buffer.from(
      hkdfSync("sha256", Buffer.from(credential, "utf8"), salt, HKDF_INFO, 32),
    )
  }

  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(credential.normalize("NFKC"), "utf8"),
      salt,
      32,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: 256 * params.N * params.r + 1024 * 1024,
      },
      (error, key) => (error ? reject(error) : resolve(Buffer.from(key))),
    )
  })
}

export function wrapDek(dek: Buffer, kek: Buffer, grantId: string): Buffer {
  return encrypt(kek, dek, `grant:${grantId}`)
}

export function unwrapDek(
  wrapped: Buffer,
  kek: Buffer,
  grantId: string,
): Buffer {
  const dek = decrypt(kek, wrapped, `grant:${grantId}`)

  if (dek.length !== DEK_BYTES) {
    throw new CryptoError("unwrapped key has the wrong length")
  }

  return dek
}
