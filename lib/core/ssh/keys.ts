import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"

import { SshFormatError, SshReader, SshWriter } from "./wire"

/**
 * SSH keys and OpenSSH certificates (PROTOCOL.certkeys): reading them from
 * the lines the owner pastes, checking a certificate's signature against the
 * CA it names, and the key PCP makes for itself. Public keys only come in
 * from outside; the one private key is PCP's own, made here and kept as a
 * managed secret (lib/core/secrets.ts), never a key someone hands in.
 */

export type KeyType =
  | "ssh-ed25519"
  | "ecdsa-sha2-nistp256"
  | "ecdsa-sha2-nistp384"
  | "ecdsa-sha2-nistp521"
  | "ssh-rsa"

const CURVES = {
  "ecdsa-sha2-nistp256": {
    id: "nistp256",
    jwk: "P-256",
    size: 32,
    hash: "sha256",
  },
  "ecdsa-sha2-nistp384": {
    id: "nistp384",
    jwk: "P-384",
    size: 48,
    hash: "sha384",
  },
  "ecdsa-sha2-nistp521": {
    id: "nistp521",
    jwk: "P-521",
    size: 66,
    hash: "sha512",
  },
} as const

type EcdsaType = keyof typeof CURVES

/** RSA keys shorter than this are refused, as OpenSSH does. */
const MIN_RSA_BITS = 2048

const CERT_SUFFIX = "-cert-v01@openssh.com"

export type SshPublicKey = {
  type: KeyType
  /** The key in SSH wire format, what a fingerprint is taken of. */
  blob: Buffer
  key: KeyObject
}

export type CertificateType = "user" | "host"

export type SshCertificate = {
  /** The certificate's own type, ssh-ed25519-cert-v01@openssh.com. */
  type: string
  /** The key it certifies. */
  publicKey: SshPublicKey
  serial: bigint
  certType: CertificateType
  keyId: string
  principals: string[]
  /** Seconds since 1970; 0 is "always", 2^64-1 is "forever". */
  validAfter: bigint
  validBefore: bigint
  criticalOptions: Array<{ name: string; value: string }>
  extensions: string[]
  /** The CA that signed it. */
  signatureKey: SshPublicKey
  /** The whole certificate in wire format, as it is sent. */
  blob: Buffer
}

const FOREVER = 0xffffffffffffffffn

function b64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

function isEcdsa(type: string): type is EcdsaType {
  return type in CURVES
}

function isKeyType(type: string): type is KeyType {
  return type === "ssh-ed25519" || type === "ssh-rsa" || isEcdsa(type)
}

/** Fixed-length big-endian bytes, for a JWK coordinate or an ECDSA half. */
function fixed(bytes: Buffer, size: number): Buffer {
  if (bytes.length > size) {
    throw new SshFormatError("A key component is too long.")
  }

  return Buffer.concat([Buffer.alloc(size - bytes.length), bytes])
}

function bitLength(unsigned: Buffer): number {
  if (unsigned.length === 0) {
    return 0
  }

  return (unsigned.length - 1) * 8 + (32 - Math.clz32(unsigned[0]!))
}

/**
 * Reads a key's fields (after its type string) and makes the KeyObject
 * that verifies with it. The same fields follow a certificate's nonce.
 */
function readKeyFields(
  reader: SshReader,
  type: KeyType,
): { key: KeyObject; blob: Buffer } {
  const writer = new SshWriter().string(type)

  if (type === "ssh-ed25519") {
    const point = reader.string()

    if (point.length !== 32) {
      throw new SshFormatError("An Ed25519 key is not 32 bytes long.")
    }

    writer.string(point)
    return {
      key: createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: b64url(point) },
        format: "jwk",
      }),
      blob: writer.toBuffer(),
    }
  }

  if (type === "ssh-rsa") {
    const e = reader.mpint()
    const n = reader.mpint()

    if (bitLength(n) < MIN_RSA_BITS) {
      throw new SshFormatError(
        `RSA keys shorter than ${MIN_RSA_BITS} bits are not accepted.`,
      )
    }

    writer.mpint(e).mpint(n)
    return {
      key: createPublicKey({
        key: { kty: "RSA", n: b64url(n), e: b64url(e) },
        format: "jwk",
      }),
      blob: writer.toBuffer(),
    }
  }

  const curve = CURVES[type]
  const id = reader.string().toString("latin1")
  const point = reader.string()

  if (id !== curve.id) {
    throw new SshFormatError("An ECDSA key names the wrong curve.")
  }

  if (point.length !== 1 + 2 * curve.size || point[0] !== 4) {
    throw new SshFormatError("An ECDSA key is not an uncompressed point.")
  }

  writer.string(id).string(point)
  return {
    key: createPublicKey({
      key: {
        kty: "EC",
        crv: curve.jwk,
        x: b64url(point.subarray(1, 1 + curve.size)),
        y: b64url(point.subarray(1 + curve.size)),
      },
      format: "jwk",
    }),
    blob: writer.toBuffer(),
  }
}

/** A plain public key from its wire format. Certificates are refused. */
export function parsePublicKeyBlob(blob: Buffer): SshPublicKey {
  const reader = new SshReader(blob)
  const type = reader.string().toString("latin1")

  if (!isKeyType(type)) {
    throw new SshFormatError(
      type.endsWith(CERT_SUFFIX)
        ? "This is a certificate, not a key."
        : `Keys of type ${type || "(none)"} are not supported.`,
    )
  }

  try {
    const { key, blob: canonical } = readKeyFields(reader, type)
    reader.end()
    return { type, blob: canonical, key }
  } catch (error) {
    if (error instanceof SshFormatError) {
      throw error
    }

    // createPublicKey refusing a point not on the curve, say.
    throw new SshFormatError("The key is not a valid public key.")
  }
}

/**
 * Splits a pasted line into type and base64. Takes the forms OpenSSH writes
 * a key or certificate in (`type base64 comment`), and a known_hosts
 * `@cert-authority patterns type base64` line.
 */
function splitLine(line: string): { type: string; data: Buffer } {
  const words = line.trim().split(/\s+/)

  if (words[0] === "@cert-authority") {
    words.splice(0, 2)
  }

  const [type, data] = words

  if (!type || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new SshFormatError(
      "Paste the key as OpenSSH writes it: its type, then the base64.",
    )
  }

  return { type, data: Buffer.from(data, "base64") }
}

/** A public key line, as in a .pub file or an @cert-authority line. */
export function parsePublicKeyLine(line: string): SshPublicKey {
  const { type, data } = splitLine(line)
  const key = parsePublicKeyBlob(data)

  if (key.type !== type) {
    throw new SshFormatError("The key's type does not match its line.")
  }

  return key
}

/**
 * The CA keys in what the owner pasted: one per line, blank lines and
 * `#` comments skipped.
 */
export function parsePublicKeyLines(text: string): SshPublicKey[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map(parsePublicKeyLine)
}

/** The key PCP's base64 line for it: `type base64 comment`. */
export function publicKeyLine(key: SshPublicKey, comment = ""): string {
  return `${key.type} ${key.blob.toString("base64")}${comment ? ` ${comment}` : ""}`
}

/** As ssh-keygen -l shows it: SHA256:base64, unpadded. */
export function fingerprint(key: SshPublicKey): string {
  return `SHA256:${createHash("sha256").update(key.blob).digest("base64").replace(/=+$/, "")}`
}

function readOptions(bytes: Buffer): Array<{ name: string; value: string }> {
  const reader = new SshReader(bytes)
  const options: Array<{ name: string; value: string }> = []

  while (reader.remaining > 0) {
    const name = reader.text()
    const data = reader.string()
    // A value is itself a string inside the data, or nothing at all.
    const value = data.length === 0 ? "" : new SshReader(data).text()
    options.push({ name, value })
  }

  return options
}

function readNames(bytes: Buffer): string[] {
  const reader = new SshReader(bytes)
  const names: string[] = []

  while (reader.remaining > 0) {
    names.push(reader.text())
  }

  return names
}

/**
 * Reads a certificate and checks the CA's signature over it. Says nothing
 * yet about whether to trust that CA, the type, the dates or the
 * principals: checkCertificate does.
 */
export function parseCertificateBlob(blob: Buffer): SshCertificate {
  const reader = new SshReader(blob)
  const type = reader.string().toString("latin1")
  const base = type.endsWith(CERT_SUFFIX)
    ? type.slice(0, -CERT_SUFFIX.length)
    : ""

  if (!isKeyType(base)) {
    throw new SshFormatError(
      isKeyType(type)
        ? "This is a plain key, not a certificate."
        : `Certificates of type ${type || "(none)"} are not supported.`,
    )
  }

  reader.string() // the nonce
  let publicKey: SshPublicKey

  try {
    const fields = readKeyFields(reader, base)
    publicKey = { type: base, ...fields }
  } catch (error) {
    if (error instanceof SshFormatError) {
      throw error
    }

    throw new SshFormatError("The certificate's key is not valid.")
  }

  const serial = reader.uint64()
  const kind = reader.uint32()
  const keyId = reader.text()
  const principals = readNames(reader.string())
  const validAfter = reader.uint64()
  const validBefore = reader.uint64()
  const criticalOptions = readOptions(reader.string())
  const extensions = readOptions(reader.string()).map((option) => option.name)
  reader.string() // reserved
  const signatureKey = parsePublicKeyBlob(reader.string())
  const signed = reader.consumed()
  const signature = reader.string()
  reader.end()

  if (kind !== 1 && kind !== 2) {
    throw new SshFormatError(
      "The certificate is neither a user's nor a host's.",
    )
  }

  if (!verifySignature(signatureKey, signature, signed)) {
    throw new SshFormatError("The certificate's signature does not verify.")
  }

  return {
    type,
    publicKey,
    serial,
    certType: kind === 1 ? "user" : "host",
    keyId,
    principals,
    validAfter,
    validBefore,
    criticalOptions,
    extensions,
    signatureKey,
    blob,
  }
}

/** A certificate line, as ssh-keygen -s writes it to …-cert.pub. */
export function parseCertificateLine(line: string): SshCertificate {
  const { type, data } = splitLine(line)
  const certificate = parseCertificateBlob(data)

  if (certificate.type !== type) {
    throw new SshFormatError("The certificate's type does not match its line.")
  }

  return certificate
}

export function certificateLine(
  certificate: SshCertificate,
  comment = "",
): string {
  return `${certificate.type} ${certificate.blob.toString("base64")}${comment ? ` ${comment}` : ""}`
}

/** When a certificate starts or stops being valid; null is "always". */
export function certificateDate(seconds: bigint): Date | null {
  if (seconds === 0n || seconds === FOREVER) {
    return null
  }

  // Past what a Date holds is as good as forever.
  return seconds > 8_640_000_000_000n ? null : new Date(Number(seconds) * 1000)
}

/**
 * Why a certificate cannot be used as the given type, for the given name,
 * now, signed by one of the given CAs; null when it can. A certificate
 * whose principals are empty is refused: OpenSSH reads that as "anyone",
 * which is not something PCP accepts from a server or sends as a user.
 */
export function certificateProblem(
  certificate: SshCertificate,
  {
    type,
    principal,
    authorities,
    now = new Date(),
  }: {
    type: CertificateType
    principal: string
    /** Null skips the CA check (PCP's own certificate: the server decides). */
    authorities: SshPublicKey[] | null
    now?: Date
  },
): string | null {
  if (certificate.certType !== type) {
    return `It is a ${certificate.certType} certificate, not a ${type} certificate.`
  }

  if (
    authorities &&
    !authorities.some((ca) => ca.blob.equals(certificate.signatureKey.blob))
  ) {
    return `It is signed by a CA you have not given PCP (${fingerprint(certificate.signatureKey)}).`
  }

  const seconds = BigInt(Math.floor(now.getTime() / 1000))

  if (seconds < certificate.validAfter) {
    return `It is not valid until ${certificateDate(certificate.validAfter)?.toISOString()}.`
  }

  if (seconds >= certificate.validBefore) {
    return `It expired at ${certificateDate(certificate.validBefore)?.toISOString()}.`
  }

  if (certificate.principals.length === 0) {
    return "It names no principals."
  }

  const wanted = type === "host" ? principal.toLowerCase() : principal
  const named = certificate.principals.map((name) =>
    type === "host" ? name.toLowerCase() : name,
  )

  if (!named.includes(wanted)) {
    return `It is not for ${principal}: it names ${certificate.principals.join(", ")}.`
  }

  // No critical option is defined for host certificates; one PCP does not
  // know must not be ignored.
  if (type === "host" && certificate.criticalOptions.length > 0) {
    return `It carries options PCP does not know (${certificate.criticalOptions.map((option) => option.name).join(", ")}).`
  }

  return null
}

/** The signature algorithms a key of each type may sign with. */
function signatureAlgorithms(type: KeyType): string[] {
  if (type === "ssh-rsa") {
    // Never ssh-rsa (SHA-1).
    return ["rsa-sha2-512", "rsa-sha2-256"]
  }

  return [type]
}

/**
 * Checks an SSH signature blob (`string algorithm, string signature`) over
 * data. `algorithm` pins the one expected, as a key exchange does.
 */
export function verifySignature(
  key: SshPublicKey,
  signatureBlob: Buffer,
  data: Buffer,
  algorithm?: string,
): boolean {
  let name: string
  let raw: Buffer

  try {
    const reader = new SshReader(signatureBlob)
    name = reader.string().toString("latin1")
    raw = reader.string()
    reader.end()
  } catch {
    return false
  }

  if (!signatureAlgorithms(key.type).includes(name)) {
    return false
  }

  if (algorithm !== undefined && name !== algorithm) {
    return false
  }

  try {
    if (key.type === "ssh-ed25519") {
      return raw.length === 64 && verify(null, data, key.key, raw)
    }

    if (key.type === "ssh-rsa") {
      return verify(
        name === "rsa-sha2-512" ? "sha512" : "sha256",
        data,
        key.key,
        raw,
      )
    }

    const curve = CURVES[key.type]
    const halves = new SshReader(raw)
    const r = halves.mpint()
    const s = halves.mpint()
    halves.end()

    return verify(
      curve.hash,
      data,
      { key: key.key, dsaEncoding: "ieee-p1363" },
      Buffer.concat([fixed(r, curve.size), fixed(s, curve.size)]),
    )
  } catch {
    return false
  }
}

/** PCP's own key: Ed25519, made once per SSH server. */
export type OwnKey = { privateKey: KeyObject; publicKey: SshPublicKey }

export function generateOwnKey(): { privatePem: string; key: OwnKey } {
  const pair = generateKeyPairSync("ed25519")
  const privatePem = pair.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString()

  return { privatePem, key: ownKeyFromPem(privatePem) }
}

/** The key as kept in its secret (PKCS#8 PEM). */
export function ownKeyFromPem(privatePem: string): OwnKey {
  const privateKey = createPrivateKeyChecked(privatePem)
  const { x } = privateKey.export({ format: "jwk" }) as { x?: string }

  if (!x) {
    throw new SshFormatError("PCP's key is not an Ed25519 key.")
  }

  const point = Buffer.from(x, "base64url")
  const blob = new SshWriter().string("ssh-ed25519").string(point).toBuffer()

  return { privateKey, publicKey: parsePublicKeyBlob(blob) }
}

function createPrivateKeyChecked(pem: string): KeyObject {
  const key = createPrivateKey({ key: pem, format: "pem" })

  if (key.asymmetricKeyType !== "ed25519") {
    throw new SshFormatError("PCP's key is not an Ed25519 key.")
  }

  return key
}

/** An Ed25519 signature blob over data. */
export function signEd25519(privateKey: KeyObject, data: Buffer): Buffer {
  return new SshWriter()
    .string("ssh-ed25519")
    .string(sign(null, data, privateKey))
    .toBuffer()
}
