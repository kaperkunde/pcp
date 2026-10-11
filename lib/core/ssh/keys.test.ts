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

describe("PCP's own key, every time", () => {
  it("is always one ssh2 can read back", () => {
    // ssh2's generator drops a leading zero byte of an Ed25519 key, which
    // one key in 256 has, and then cannot read the key it wrote. 2000 keys
    // meet such a one all but always.
    for (let n = 0; n < 2000; n++) {
      const key = generateOwnKey("pcp-test")

      expect(utils.parseKey(key.privateKey)).not.toBeInstanceOf(Error)
      expect(utils.parseKey(key.publicKey)).not.toBeInstanceOf(Error)
    }
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
