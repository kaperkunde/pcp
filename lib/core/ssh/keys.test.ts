import { generateKeyPairSync, sign } from "node:crypto"

import { describe, expect, it } from "vitest"

import { issueCertificate, makeEd25519 } from "./fake-server"
import {
  certificateLine,
  certificateProblem,
  fingerprint,
  generateOwnKey,
  ownKeyFromPem,
  parseCertificateBlob,
  parseCertificateLine,
  parsePublicKeyBlob,
  parsePublicKeyLine,
  parsePublicKeyLines,
  publicKeyLine,
  verifySignature,
} from "./keys"
import { SshWriter } from "./wire"

function jwkBlob(type: "ssh-rsa" | "ecdsa-sha2-nistp256", bits = 2048) {
  if (type === "ssh-rsa") {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: bits,
    })
    const { n, e } = publicKey.export({ format: "jwk" }) as {
      n: string
      e: string
    }
    return {
      privateKey,
      blob: new SshWriter()
        .string("ssh-rsa")
        .mpint(Buffer.from(e, "base64url"))
        .mpint(Buffer.from(n, "base64url"))
        .toBuffer(),
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  })
  const { x, y } = publicKey.export({ format: "jwk" }) as {
    x: string
    y: string
  }
  return {
    privateKey,
    blob: new SshWriter()
      .string("ecdsa-sha2-nistp256")
      .string("nistp256")
      .string(
        Buffer.concat([
          Buffer.from([4]),
          Buffer.from(x, "base64url"),
          Buffer.from(y, "base64url"),
        ]),
      )
      .toBuffer(),
  }
}

describe("public keys", () => {
  it("reads a key line back as it was written", () => {
    const { publicKey } = makeEd25519()
    const line = publicKeyLine(publicKey, "ca@example")
    const read = parsePublicKeyLine(line)

    expect(read.type).toBe("ssh-ed25519")
    expect(read.blob.equals(publicKey.blob)).toBe(true)
    expect(fingerprint(read)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it("reads @cert-authority lines, skipping blanks and comments", () => {
    const one = makeEd25519().publicKey
    const two = makeEd25519().publicKey
    const keys = parsePublicKeyLines(
      [
        "# the CA",
        `@cert-authority *.example.com ${publicKeyLine(one)}`,
        "",
        publicKeyLine(two, "second"),
      ].join("\n"),
    )

    expect(keys.map((key) => key.blob)).toEqual([one.blob, two.blob])
  })

  it("reads RSA and ECDSA keys", () => {
    expect(parsePublicKeyBlob(jwkBlob("ssh-rsa").blob).type).toBe("ssh-rsa")
    expect(parsePublicKeyBlob(jwkBlob("ecdsa-sha2-nistp256").blob).type).toBe(
      "ecdsa-sha2-nistp256",
    )
  })

  it("refuses short RSA keys, certificates, garbage and mismatched lines", () => {
    expect(() => parsePublicKeyBlob(jwkBlob("ssh-rsa", 1024).blob)).toThrow(
      /shorter than 2048/,
    )

    const ca = makeEd25519()
    const certificate = issueCertificate({
      ca,
      key: makeEd25519().publicKey,
      type: "host",
      principals: ["a"],
    })
    expect(() => parsePublicKeyBlob(certificate.blob)).toThrow(
      /certificate, not a key/,
    )
    expect(() => parsePublicKeyLine("not a key")).toThrow()
    expect(() =>
      parsePublicKeyLine(`ssh-rsa ${ca.publicKey.blob.toString("base64")}`),
    ).toThrow(/does not match/)
  })
})

describe("signatures", () => {
  const data = Buffer.from("exchange hash")

  it("verifies ECDSA and RSA (SHA-2) signatures", () => {
    const ec = jwkBlob("ecdsa-sha2-nistp256")
    const raw = sign("sha256", data, {
      key: ec.privateKey,
      dsaEncoding: "ieee-p1363",
    })
    const ecSignature = new SshWriter()
      .string("ecdsa-sha2-nistp256")
      .string(
        new SshWriter()
          .mpint(raw.subarray(0, 32))
          .mpint(raw.subarray(32))
          .toBuffer(),
      )
      .toBuffer()
    expect(
      verifySignature(parsePublicKeyBlob(ec.blob), ecSignature, data),
    ).toBe(true)

    const rsa = jwkBlob("ssh-rsa")
    const rsaKey = parsePublicKeyBlob(rsa.blob)
    const rsaSignature = (name: string, hash: string) =>
      new SshWriter()
        .string(name)
        .string(sign(hash, data, rsa.privateKey))
        .toBuffer()

    expect(
      verifySignature(rsaKey, rsaSignature("rsa-sha2-512", "sha512"), data),
    ).toBe(true)
    expect(
      verifySignature(
        rsaKey,
        rsaSignature("rsa-sha2-512", "sha512"),
        data,
        "rsa-sha2-256",
      ),
    ).toBe(false)
    // SHA-1 signatures are never accepted.
    expect(verifySignature(rsaKey, rsaSignature("ssh-rsa", "sha1"), data)).toBe(
      false,
    )
  })

  it("refuses a signature by another key", () => {
    const signer = makeEd25519()
    const other = makeEd25519()
    const signature = new SshWriter()
      .string("ssh-ed25519")
      .string(sign(null, data, signer.privateKey))
      .toBuffer()

    expect(verifySignature(signer.publicKey, signature, data)).toBe(true)
    expect(verifySignature(other.publicKey, signature, data)).toBe(false)
    expect(verifySignature(signer.publicKey, Buffer.from("x"), data)).toBe(
      false,
    )
  })
})

describe("certificates", () => {
  const ca = makeEd25519()
  const key = makeEd25519().publicKey
  const now = new Date("2026-06-01T00:00:00Z")
  const at = (iso: string) => BigInt(Date.parse(iso) / 1000)

  it("reads a certificate line and the fields the owner is shown", () => {
    const issued = issueCertificate({
      ca,
      key,
      type: "user",
      principals: ["deploy"],
      keyId: "pcp@vault",
      criticalOptions: [{ name: "force-command", value: "/usr/bin/uptime" }],
    })
    const read = parseCertificateLine(certificateLine(issued, "comment"))

    expect(read.certType).toBe("user")
    expect(read.keyId).toBe("pcp@vault")
    expect(read.principals).toEqual(["deploy"])
    expect(read.criticalOptions).toEqual([
      { name: "force-command", value: "/usr/bin/uptime" },
    ])
    expect(read.extensions).toEqual(["permit-pty"])
    expect(read.publicKey.blob.equals(key.blob)).toBe(true)
    expect(read.signatureKey.blob.equals(ca.publicKey.blob)).toBe(true)
  })

  it("refuses a certificate whose signature does not cover it", () => {
    const issued = issueCertificate({
      ca,
      key,
      type: "host",
      principals: ["host.example"],
      keyId: "aaaa",
    })
    const tampered = Buffer.from(issued.blob)
    const at = tampered.indexOf(Buffer.from("aaaa"))
    tampered[at] = "b".charCodeAt(0)

    expect(() => parseCertificateBlob(tampered)).toThrow(/does not verify/)
    expect(() => parseCertificateBlob(key.blob)).toThrow(/not a certificate/)
  })

  it("names what is wrong with a certificate for its use", () => {
    const check = (
      overrides: Partial<Parameters<typeof issueCertificate>[0]>,
      use: Partial<Parameters<typeof certificateProblem>[1]> = {},
    ) =>
      certificateProblem(
        issueCertificate({
          ca,
          key,
          type: "host",
          principals: ["Host.Example"],
          ...overrides,
        }),
        {
          type: "host",
          principal: "host.example",
          authorities: [ca.publicKey],
          now,
          ...use,
        },
      )

    expect(check({})).toBeNull()
    expect(check({ type: "user" })).toMatch(/user certificate/)
    expect(check({ ca: makeEd25519() })).toMatch(/CA you have not given/)
    expect(check({ validAfter: at("2026-07-01T00:00:00Z") })).toMatch(
      /not valid until/,
    )
    expect(check({ validBefore: at("2026-05-01T00:00:00Z") })).toMatch(
      /expired/,
    )
    expect(check({ principals: [] })).toMatch(/no principals/)
    expect(check({ principals: ["other.example"] })).toMatch(
      /not for host.example/,
    )
    expect(
      check({ criticalOptions: [{ name: "something-new", value: "" }] }),
    ).toMatch(/options PCP does not know/)
    // User logins are case-sensitive, host names are not.
    expect(
      check(
        { type: "user", principals: ["Deploy"] },
        { type: "user", principal: "deploy" },
      ),
    ).toMatch(/not for deploy/)
  })
})

describe("PCP's own key", () => {
  it("round-trips through its PEM", () => {
    const { privatePem, key } = generateOwnKey()
    const again = ownKeyFromPem(privatePem)

    expect(privatePem).toContain("BEGIN PRIVATE KEY")
    expect(again.publicKey.blob.equals(key.publicKey.blob)).toBe(true)
    expect(publicKeyLine(again.publicKey)).toMatch(/^ssh-ed25519 /)
  })

  it("refuses a PEM that is not Ed25519", () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString()

    expect(() => ownKeyFromPem(pem)).toThrow(/not an Ed25519 key/)
  })
})
