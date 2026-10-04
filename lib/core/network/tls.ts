import { X509Certificate } from "node:crypto"
import { promises as dnsPromises } from "node:dns"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

import { dataDir } from "../data-dir"
import { invalid } from "../errors"
import { getHostJson, setHostJson } from "../host-settings"
import { ddnsHostname, type DdnsConfig, normalizeHostname } from "./ddns"

/**
 * HTTPS with a Let's Encrypt certificate, for an owner without a proxy of
 * their own. Off unless turned on. The certificate is got with the HTTP-01
 * challenge: Let's Encrypt asks for a file on port 80 of the name, which
 * the edge listener (edge.ts) answers from `challenges`.
 *
 * The keys are files under <data>/tls, readable by PCP alone: a server
 * presenting a certificate must hold its key in the clear, before anyone
 * has signed in.
 */

export type TlsConfig = {
  /** The name typed by the owner, or null to use the dynamic DNS name. */
  domain: string | null
  email: string | null
  /** When the owner accepted Let's Encrypt's agreement. */
  agreedAt: string
}

export type TlsState = "issuing" | "active" | "failed"

export type TlsStatus = {
  state?: TlsState
  domain?: string
  notBefore?: string
  notAfter?: string
  lastError?: string
  /** Advice from the DNS check before asking: not a failure. */
  warning?: string
  failures?: number
  nextAttemptAt?: string
}

export const TLS_CONFIG_KEY = "tls.config"
export const TLS_STATUS_KEY = "tls.status"

/** How often PCP looks at whether a renewal or a retry is due. */
export const TLS_CHECK_INTERVAL_MS = 30 * 60_000
const RETRY_FIRST_MS = 60 * 60_000
const RETRY_MAX_MS = 24 * 60 * 60_000

export const LETS_ENCRYPT_DIRECTORY =
  "https://acme-v02.api.letsencrypt.org/directory"

export function acmeDirectory(): string {
  return process.env.PCP_ACME_DIRECTORY?.trim() || LETS_ENCRYPT_DIRECTORY
}

/** The name the certificate is for: the typed one, or the dynamic DNS one. */
export function tlsDomain(
  config: TlsConfig | null,
  ddns: DdnsConfig | null,
): string | null {
  if (!config) {
    return null
  }

  return config.domain ?? ddnsHostname(ddns)
}

export type TlsInput = {
  domain: string
  useDdnsName: boolean
  email: string
  agreed: boolean
}

export function parseTlsInput(
  input: TlsInput,
  ddns: DdnsConfig | null,
  now: Date,
): TlsConfig {
  if (!input.agreed) {
    throw invalid(
      "Let's Encrypt only issues a certificate once you accept its agreement.",
    )
  }

  let domain: string | null = null

  if (input.useDdnsName) {
    if (!ddnsHostname(ddns)) {
      throw invalid(
        "Set up dynamic DNS with a name first, or type the name PCP is reached on.",
      )
    }
  } else {
    domain = normalizeHostname(input.domain, "name")

    if (domain === "localhost" || domain.endsWith(".local")) {
      throw invalid("Let's Encrypt only issues certificates for public names.")
    }
  }

  const email = input.email.trim()

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalid("That email address does not look right.")
  }

  return { domain, email: email || null, agreedAt: now.toISOString() }
}

// ---------------------------------------------------------------------------
// Files

export function tlsDir(): string {
  return path.join(dataDir(), "tls")
}

function domainDir(domain: string): string {
  return path.join(tlsDir(), domain)
}

/** Writes a file only PCP can read, replacing the old one in one step. */
function writePrivate(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, contents, { mode: 0o600 })
  renameSync(temporary, file)
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

export type Certificate = {
  key: string
  cert: string
  notBefore: Date
  notAfter: Date
}

/** The saved certificate for `domain`, if there is one that names it. */
export function readCertificate(domain: string): Certificate | null {
  const key = readText(path.join(domainDir(domain), "key.pem"))
  const cert = readText(path.join(domainDir(domain), "cert.pem"))

  if (!key || !cert) {
    return null
  }

  try {
    const x509 = new X509Certificate(cert)

    if (!x509.checkHost(domain)) {
      return null
    }

    return {
      key,
      cert,
      notBefore: new Date(x509.validFrom),
      notAfter: new Date(x509.validTo),
    }
  } catch {
    return null
  }
}

export function writeCertificate(domain: string, key: string, cert: string) {
  writePrivate(path.join(domainDir(domain), "key.pem"), key)
  writePrivate(path.join(domainDir(domain), "cert.pem"), cert)
}

/**
 * Renew once less than a third of the certificate's life is left: 30 days
 * of a 90-day certificate, and in proportion as Let's Encrypt shortens them.
 */
export function needsRenewal(cert: Certificate, now: Date): boolean {
  const life = cert.notAfter.getTime() - cert.notBefore.getTime()
  return cert.notAfter.getTime() - now.getTime() < life / 3
}

// ---------------------------------------------------------------------------
// Issuing

/** Puts the answer to a challenge where port 80 serves it, and takes it away. */
export type ChallengeStore = Map<string, string>

export type Issuer = (request: {
  domain: string
  email: string | null
  challenges: ChallengeStore
}) => Promise<{ key: string; cert: string }>

/** Asks the ACME directory (Let's Encrypt) for a certificate. */
export const acmeIssuer: Issuer = async ({ domain, email, challenges }) => {
  const acme = await import("acme-client")
  // acme-client retries a failed request five times, waiting up to 25
  // seconds between tries. A round that fails is tried again in an hour
  // anyway; one retry (honouring Retry-After) is plenty, and keeps the page
  // from saying "getting a certificate" for over a minute.
  const defaults = acme.axios.defaults as unknown as {
    acmeSettings?: { retryMaxAttempts: number }
  }
  if (defaults.acmeSettings) defaults.acmeSettings.retryMaxAttempts = 1
  const accountFile = path.join(tlsDir(), "account.key")
  let accountKey = readText(accountFile)

  if (!accountKey) {
    accountKey = (await acme.crypto.createPrivateEcdsaKey()).toString()
    writePrivate(accountFile, accountKey)
  }

  const client = new acme.Client({
    directoryUrl: acmeDirectory(),
    accountKey,
  })
  const [key, csr] = await acme.crypto.createCsr(
    { commonName: domain, altNames: [domain] },
    await acme.crypto.createPrivateEcdsaKey(),
  )

  const cert = await client.auto({
    csr,
    email: email ?? undefined,
    termsOfServiceAgreed: true,
    challengePriority: ["http-01"],
    // acme-client would first fetch the challenge itself, through the
    // owner's router; many home routers cannot loop back like that.
    skipChallengeVerification: true,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      challenges.set(challenge.token, keyAuthorization)
    },
    challengeRemoveFn: async (_authz, challenge) => {
      challenges.delete(challenge.token)
    },
  })

  return { key: key.toString(), cert }
}

/** Advice when the name does not point at this network: PCP asks anyway. */
export async function checkDns(
  domain: string,
  expectedIp: string | undefined,
  resolve4: (name: string) => Promise<string[]> = (name) =>
    dnsPromises.resolve4(name),
): Promise<string | undefined> {
  try {
    const addresses = await resolve4(domain)

    if (expectedIp && !addresses.includes(expectedIp)) {
      return `${domain} points at ${addresses.join(", ")}, but this network's address is ${expectedIp}. If you just changed it, give it a few minutes.`
    }

    return undefined
  } catch {
    return `${domain} does not have an address yet. If you just set it up, give it a few minutes.`
  }
}

function explain(domain: string, error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .trim()
    .replace(/\.+$/, "")
  const hint =
    /connection|timeout|firewall|refused|unauthorized|invalid response|404|dns/i.test(
      message,
    )
      ? ` Check that ${domain} points at this network and that port 80 on your router is forwarded to this computer.`
      : ""

  return `Let's Encrypt did not issue a certificate for ${domain}: ${message}.${hint}`
}

/**
 * One round: keep the certificate the saved one, renew or get one when
 * that is due, and wait longer after each failure. Returns the status to
 * keep and the certificate to serve, if there is one.
 */
export async function runTlsRound({
  domain,
  config,
  status,
  now,
  force = false,
  expectedIp,
  issue = acmeIssuer,
  challenges,
  resolve4,
  onIssuing,
}: {
  domain: string | null
  config: TlsConfig
  status: TlsStatus
  now: Date
  force?: boolean
  expectedIp?: string
  issue?: Issuer
  challenges: ChallengeStore
  resolve4?: (name: string) => Promise<string[]>
  /** Told before PCP asks, so the page can say a certificate is on its way. */
  onIssuing?: (status: TlsStatus) => Promise<void>
}): Promise<{ status: TlsStatus; certificate: Certificate | null }> {
  if (!domain) {
    return {
      status: {
        state: "failed",
        lastError:
          "There is no name to get a certificate for: set up dynamic DNS, or type the name PCP is reached on.",
      },
      certificate: null,
    }
  }

  // A different name starts again.
  const previous: TlsStatus = status.domain === domain ? status : {}
  const existing = readCertificate(domain)

  if (existing && !needsRenewal(existing, now)) {
    return {
      status: {
        state: "active",
        domain,
        notBefore: existing.notBefore.toISOString(),
        notAfter: existing.notAfter.toISOString(),
      },
      certificate: existing,
    }
  }

  if (
    !force &&
    previous.nextAttemptAt &&
    now.getTime() < Date.parse(previous.nextAttemptAt)
  ) {
    return { status: previous, certificate: existing }
  }

  const warning = await checkDns(domain, expectedIp, resolve4)
  await onIssuing?.({
    ...previous,
    state: existing ? "active" : "issuing",
    domain,
    warning,
    lastError: undefined,
  })

  try {
    const { key, cert } = await issue({
      domain,
      email: config.email,
      challenges,
    })
    writeCertificate(domain, key, cert)
    const saved = readCertificate(domain)

    if (!saved) {
      throw new Error("the certificate it sent does not name this domain")
    }

    return {
      status: {
        state: "active",
        domain,
        notBefore: saved.notBefore.toISOString(),
        notAfter: saved.notAfter.toISOString(),
      },
      certificate: saved,
    }
  } catch (error) {
    const failures = (previous.failures ?? 0) + 1
    const wait = Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS)

    return {
      status: {
        // A certificate that still works keeps being served while renewal
        // fails.
        state: existing ? "active" : "failed",
        domain,
        notBefore: existing?.notBefore.toISOString(),
        notAfter: existing?.notAfter.toISOString(),
        lastError: explain(domain, error),
        warning,
        failures,
        nextAttemptAt: new Date(now.getTime() + wait).toISOString(),
      },
      certificate: existing,
    }
  }
}

// ---------------------------------------------------------------------------
// Stored settings

export async function getTlsConfig(): Promise<TlsConfig | null> {
  return getHostJson<TlsConfig>(TLS_CONFIG_KEY)
}

export async function getTlsStatus(): Promise<TlsStatus> {
  return (await getHostJson<TlsStatus>(TLS_STATUS_KEY)) ?? {}
}

export async function saveTlsStatus(status: TlsStatus): Promise<void> {
  await setHostJson(TLS_STATUS_KEY, status)
}

export async function saveTlsConfig(
  input: TlsInput,
  ddns: DdnsConfig | null,
  now = new Date(),
): Promise<TlsConfig> {
  const config = parseTlsInput(input, ddns, now)
  await setHostJson(TLS_CONFIG_KEY, config)
  // A save is a fresh start: no waiting out an earlier failure.
  await setHostJson(TLS_STATUS_KEY, null)
  return config
}

/** Turns HTTPS off. The certificate files stay, for turning it on again. */
export async function clearTlsConfig(): Promise<void> {
  await setHostJson(TLS_CONFIG_KEY, null)
  await setHostJson(TLS_STATUS_KEY, null)
}
