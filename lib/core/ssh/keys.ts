import { createHash } from "node:crypto"

import { utils } from "ssh2"

/**
 * The keys an SSH server involves: PCP's own (made here, kept as a managed
 * secret in lib/core/secrets.ts, never one someone hands in) and the
 * server's host key, which PCP pins the first time it sees it. Parsing and
 * signing are ssh2's; this file only names and compares keys.
 */

export type OwnKey = {
  /** OpenSSH's private key format, what ssh2 signs with. */
  privateKey: string
  /** `ssh-ed25519 base64 comment`, for the login's authorized_keys. */
  publicKey: string
}

/** An Ed25519 key for one server, with a comment that names it. */
export function generateOwnKey(comment: string): OwnKey {
  const pair = utils.generateKeyPairSync("ed25519", { comment })
  return { privateKey: pair.private, publicKey: pair.public.trim() }
}

/** The key type a wire-format key blob starts with. */
function blobType(blob: Buffer): string {
  if (blob.length < 4) {
    return ""
  }

  const length = blob.readUInt32BE(0)
  return length <= blob.length - 4 && length < 64
    ? blob.subarray(4, 4 + length).toString("latin1")
    : ""
}

/** A host key as PCP stores it: `type base64`, from its wire format. */
export function hostKeyLine(blob: Buffer): string {
  return `${blobType(blob) || "unknown"} ${blob.toString("base64")}`
}

/** As ssh-keygen -l shows it: SHA256:base64, unpadded. */
export function fingerprint(line: string): string {
  const data = line.trim().split(/\s+/)[1] ?? ""
  const digest = createHash("sha256")
    .update(Buffer.from(data, "base64"))
    .digest("base64")
  return `SHA256:${digest.replace(/=+$/, "")}`
}

/** A stored key line's type, for showing next to its fingerprint. */
export function keyType(line: string): string {
  return line.trim().split(/\s+/)[0] ?? ""
}
