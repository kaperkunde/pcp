import { createHmac, hkdfSync } from "node:crypto"

/**
 * A keyed hash of a vault's text, for finding a row by a value that is
 * stored sealed (a secret's name, a site's host): HMAC-SHA256 under a key
 * derived from the vault's data key with HKDF, one key per `label`, so a
 * hash made for one purpose never matches one made for another. Without
 * the data key it says nothing about the text, not even that two vaults
 * hold the same one. Pure: the key comes in as an argument.
 */
export function keyedHash(
  dek: Uint8Array | Buffer,
  label: string,
  text: string,
): string {
  const key = Buffer.from(
    hkdfSync("sha256", dek, Buffer.alloc(0), `pcp keyed hash: ${label}`, 32),
  )

  return createHmac("sha256", key).update(text, "utf8").digest("hex")
}
