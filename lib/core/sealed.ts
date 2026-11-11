import { asBytes, decryptString, encryptString } from "./crypto"

/**
 * Descriptive values of the owner's (names, addresses, descriptions) kept
 * sealed at rest: AES-256-GCM under the vault's data key, the row and the
 * column as associated data (`<table>:<id>:<column>`), so a sealed value
 * opens only where it was written and never as another column's.
 *
 * Rows from before a value was sealed hold it in its old plain column and
 * nothing here: every reader takes the sealed value when there is one and
 * the plain one otherwise, until the vault's rows are converted
 * (lib/core/sealing/convert.ts).
 */

export type Sealed = Uint8Array<ArrayBuffer>

export function sealText(dek: Buffer, aad: string, text: string): Sealed {
  return asBytes(encryptString(dek, text, aad))
}

/** The sealed value when there is one, else the plain column's. */
export function openText(
  dek: Buffer,
  aad: string,
  sealed: Uint8Array | null | undefined,
  plain: string,
): string {
  return sealed ? decryptString(dek, Buffer.from(sealed), aad) : plain
}

export function sealJson(dek: Buffer, aad: string, value: unknown): Sealed {
  return sealText(dek, aad, JSON.stringify(value))
}

export function openJson<T>(
  dek: Buffer,
  aad: string,
  sealed: Uint8Array | null | undefined,
): T | null {
  return sealed ? (JSON.parse(openText(dek, aad, sealed, "")) as T) : null
}

/**
 * A sealed value in a text column (a setting's value): a prefix no plain
 * value of PCP's starts with, then the ciphertext in base64.
 */
const TEXT_PREFIX = "pcp-sealed:v1:"

export function sealToText(dek: Buffer, aad: string, text: string): string {
  return `${TEXT_PREFIX}${Buffer.from(encryptString(dek, text, aad)).toString("base64")}`
}

export function isSealedText(value: string): boolean {
  return value.startsWith(TEXT_PREFIX)
}

export function openFromText(dek: Buffer, aad: string, value: string): string {
  return isSealedText(value)
    ? decryptString(
        dek,
        Buffer.from(value.slice(TEXT_PREFIX.length), "base64"),
        aad,
      )
    : value
}
