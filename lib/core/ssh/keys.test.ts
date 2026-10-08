import { createHash } from "node:crypto"

import { utils } from "ssh2"
import { describe, expect, it } from "vitest"

import { fingerprint, generateOwnKey, hostKeyLine, keyType } from "./keys"

describe("PCP's own key", () => {
  it("is an Ed25519 key in OpenSSH's formats, named by its comment", () => {
    const key = generateOwnKey("pcp-build-box")

    expect(key.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY")
    expect(key.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ pcp-build-box$/)
    // Each server gets a key of its own.
    expect(generateOwnKey("x").publicKey).not.toBe(key.publicKey)
  })
})

describe("host keys", () => {
  it("are stored as type and base64, fingerprinted as ssh-keygen does", () => {
    const parsed = utils.parseKey(generateOwnKey("host").publicKey)
    if (parsed instanceof Error || Array.isArray(parsed)) {
      throw new Error("unreadable")
    }
    const blob = parsed.getPublicSSH()
    const line = hostKeyLine(blob)

    expect(line).toBe(`ssh-ed25519 ${blob.toString("base64")}`)
    expect(keyType(line)).toBe("ssh-ed25519")
    expect(fingerprint(line)).toBe(
      `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    )
  })

  it("names a blob it cannot read as unknown rather than guessing", () => {
    expect(keyType(hostKeyLine(Buffer.from([0, 0, 1, 0, 1])))).toBe("unknown")
  })
})
