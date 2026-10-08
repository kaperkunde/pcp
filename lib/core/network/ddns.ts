import { isIP } from "node:net"

import {
  DDNS_PROVIDERS,
  type DdnsProvider,
  readDuckDnsPaste,
} from "../constants"
import { invalid } from "../errors"
import { getHostJson, setHostJson } from "../host-settings"
import { PCP_VERSION } from "../version"

/**
 * Dynamic DNS: keeping a name (yourname.duckdns.org) pointed at the public
 * address of the network PCP runs on, for an owner whose internet provider
 * changes it now and then.
 *
 * The credential the service wants is a host setting, stored unencrypted:
 * the update has to run while nobody is signed in, and nothing may read the
 * vault without a credential (ARCHITECTURE.md, "Reaching PCP"). The owner is
 * told so where they type it. It can only move the name.
 *
 * The cadence follows what dyndns2 services ask of clients: look the
 * address up often, send an update only when it changed (or once a day, so
 * the service knows the name is in use), back off when the service is
 * unwell, and stop altogether when it says the login is wrong, until the
 * owner changes the settings. Services block clients that keep retrying a
 * bad login.
 */

export type DdnsConfig =
  | { provider: "duckdns"; subdomain: string; token: string }
  | {
      provider: "dyndns2"
      server: string
      hostname: string
      username: string
      password: string
    }
  | { provider: "cloudflare"; apiToken: string; zone: string; record: string }
  | { provider: "custom"; url: string; hostname: string }

export type DdnsStatus = {
  /** The address the service was last told (or reported). */
  lastIp?: string
  lastUpdatedAt?: string
  lastCheckedAt?: string
  lastError?: string
  /** Consecutive failures that may go away by themselves. */
  failures?: number
  nextAttemptAt?: string
  /** Set when the service refused the login: no more tries until a save. */
  stopped?: string
}

export const DDNS_CONFIG_KEY = "ddns.config"
export const DDNS_STATUS_KEY = "ddns.status"

/** How often the public address is looked up. */
export const DDNS_CHECK_INTERVAL_MS = 5 * 60_000
/** An unchanged address is still sent this often. */
export const DDNS_REFRESH_MS = 24 * 60 * 60_000
/** Updates without knowing the address (the lookup failed), at most this often. */
export const DDNS_BLIND_INTERVAL_MS = 60 * 60_000
const BACKOFF_MS = [5, 10, 20, 60].map((minutes) => minutes * 60_000)

const REQUEST_TIMEOUT_MS = 10_000

export const PUBLIC_IP_SERVICES = [
  "https://api.ipify.org",
  "https://ipv4.icanhazip.com",
  "https://ifconfig.me/ip",
]

export const USER_AGENT = `PCP/${PCP_VERSION} (+https://github.com/kaperkunde/pcp)`

type Fetch = typeof fetch

// ---------------------------------------------------------------------------
// Reading what the owner typed

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const DUCKDNS_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A DNS name PCP can be reached on: lower case, no IP address, a dot. */
export function normalizeHostname(input: string, what = "name"): string {
  const name = input.trim().toLowerCase().replace(/\.$/, "")

  if (isIP(name)) {
    throw invalid(`Enter a ${what}, not an IP address.`)
  }

  if (!HOSTNAME.test(name)) {
    throw invalid(`“${input.trim()}” is not a ${what} PCP can use.`)
  }

  return name
}

export type DdnsInput = {
  provider: string
  subdomain?: string
  token?: string
  server?: string
  hostname?: string
  username?: string
  password?: string
  apiToken?: string
  zone?: string
  record?: string
  url?: string
}

/**
 * The settings to save from the form. A credential left blank keeps the
 * one saved before for the same service, since the page never shows it,
 * but only where it would go to the same place: a dyndns2 password for the
 * same service address and username (the other services' addresses are
 * fixed, and a custom update address is itself the credential).
 */
export function parseDdnsInput(
  input: DdnsInput,
  previous: DdnsConfig | null,
): DdnsConfig {
  const provider = input.provider as DdnsProvider

  if (!DDNS_PROVIDERS.includes(provider)) {
    throw invalid("Choose a dynamic DNS service.")
  }

  const kept = <K extends string>(value: string | undefined, key: K) => {
    const typed = value?.trim() ?? ""

    if (typed) {
      return typed
    }

    if (previous?.provider === provider && key in previous) {
      return (previous as Record<string, string>)[key] ?? ""
    }

    return ""
  }

  switch (provider) {
    case "duckdns": {
      const pasted = readDuckDnsPaste(input.token ?? "")
      const subdomain =
        (input.subdomain ?? "")
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\.duckdns\.org\.?\/?$/, "") ||
        (pasted.subdomain ?? "")

      if (!DUCKDNS_SUBDOMAIN.test(subdomain)) {
        throw invalid(
          "Enter your DuckDNS name: the part before .duckdns.org, letters, digits and hyphens.",
        )
      }

      if (input.token?.trim() && !pasted.token) {
        throw invalid(
          "That is not a DuckDNS token. It is shown at the top of duckdns.org once you sign in, like a7c4d0ad-114e-40ef-ba1d-d217904a50f2.",
        )
      }

      const token = pasted.token ?? kept(undefined, "token")

      if (!token) {
        throw invalid("Paste your DuckDNS token (it is on duckdns.org).")
      }

      return { provider, subdomain, token }
    }

    case "dyndns2": {
      const server = normalizeHostname(
        (input.server ?? "").replace(/^https?:\/\//i, "").replace(/\/.*$/, ""),
        "service address",
      )
      const hostname = normalizeHostname(input.hostname ?? "", "host name")
      const username = input.username?.trim() ?? ""
      const saved = previous?.provider === "dyndns2" ? previous : null

      // The saved password goes only to the service and login it was typed
      // for: a save that sends it on at once must not send it to a new one.
      if (
        !input.password?.trim() &&
        saved?.password &&
        (saved.server !== server || saved.username !== username)
      ) {
        throw invalid(
          "Enter the password again: the saved one is sent only to the service address and username it was saved with.",
        )
      }

      const password = kept(input.password, "password")

      if (!username || !password) {
        throw invalid("Enter the username and password for the service.")
      }

      return { provider, server, hostname, username, password }
    }

    case "cloudflare": {
      const zone = normalizeHostname(input.zone ?? "", "domain")
      const rawRecord = (input.record ?? "").trim().toLowerCase()
      const record =
        rawRecord === "" || rawRecord === "@"
          ? zone
          : normalizeHostname(
              rawRecord.endsWith(`.${zone}`) || rawRecord === zone
                ? rawRecord
                : `${rawRecord}.${zone}`,
              "name",
            )
      const apiToken = kept(input.apiToken, "apiToken")

      if (!apiToken) {
        throw invalid(
          "Paste a Cloudflare API token that may edit this domain's DNS.",
        )
      }

      return { provider, apiToken, zone, record }
    }

    case "custom": {
      const url = kept(input.url, "url")

      if (!url) {
        throw invalid("Enter the address that updates your name.")
      }

      const parsed = parseUrl(fillTemplate(url, "203.0.113.1", "example.com"))

      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw invalid("The update address must start with https:// or http://.")
      }

      const hostname = input.hostname?.trim()
        ? normalizeHostname(input.hostname, "name")
        : ""

      return { provider, url, hostname }
    }
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw invalid(
      "Enter the full update address, like https://example.com/update?ip={ip}.",
    )
  }
}

function fillTemplate(template: string, ip: string, hostname: string): string {
  return template
    .replaceAll("{ip}", encodeURIComponent(ip))
    .replaceAll("{hostname}", encodeURIComponent(hostname))
}

/** The name the service points at this machine, for HTTPS to use. */
export function ddnsHostname(config: DdnsConfig | null): string | null {
  if (!config) {
    return null
  }

  switch (config.provider) {
    case "duckdns":
      return `${config.subdomain}.duckdns.org`
    case "dyndns2":
      return config.hostname
    case "cloudflare":
      return config.record
    case "custom":
      return config.hostname || null
  }
}

/**
 * Whether the service can see the address from the request itself, so an
 * update without one still works when PCP could not look it up.
 */
export function detectsAddressItself(config: DdnsConfig): boolean {
  switch (config.provider) {
    case "duckdns":
    case "dyndns2":
      return true
    case "cloudflare":
      return false
    case "custom":
      return !config.url.includes("{ip}")
  }
}

// ---------------------------------------------------------------------------
// The public address

/** A public IPv4 address, as a lookup service answers it, or null. */
export function parsePublicIpv4(text: string): string | null {
  const candidate = text.trim()

  if (isIP(candidate) !== 4) {
    return null
  }

  const [a, b] = candidate.split(".").map(Number)
  const notPublic =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)

  return notPublic ? null : candidate
}

function publicIpServices(): string[] {
  const configured = process.env.PCP_PUBLIC_IP_URL?.trim()
  return configured ? [configured] : PUBLIC_IP_SERVICES
}

/** This network's public IPv4 address, asking services in turn, or null. */
export async function lookupPublicIp(
  fetchFn: Fetch = fetch,
  services: string[] = publicIpServices(),
): Promise<string | null> {
  for (const service of services) {
    try {
      const response = await fetchFn(service, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(5_000),
      })

      if (!response.ok) {
        continue
      }

      const ip = parsePublicIpv4(await response.text())

      if (ip) {
        return ip
      }
    } catch {
      // The next service.
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Sending an update

export type UpdateResult =
  { ok: true; ip?: string } | { ok: false; hard: boolean; message: string }

const DYNDNS2_HARD: Record<string, string> = {
  badauth: "The service refused the username or password.",
  "!donator": "The service says this account cannot use that feature.",
  notfqdn: "The service says the host name is not a full name.",
  nohost: "The service has no host by that name in this account.",
  numhost: "The service refused: too many host names in one update.",
  abuse: "The service has blocked updates for this name for abuse.",
  badagent: "The service refused PCP's updates.",
}

/** A dyndns2 answer: `good 1.2.3.4`, `nochg 1.2.3.4`, or a refusal. */
export function readDyndns2Answer(text: string): UpdateResult {
  const [code = "", detail = ""] = text.trim().split(/\s+/)

  if (code === "good" || code === "nochg") {
    return { ok: true, ip: parsePublicIpv4(detail) ?? undefined }
  }

  if (code in DYNDNS2_HARD) {
    return { ok: false, hard: true, message: DYNDNS2_HARD[code] }
  }

  return {
    ok: false,
    hard: false,
    message: `The service answered “${clip(text)}”. PCP will try again.`,
  }
}

/** DuckDNS's verbose answer: `OK\n1.2.3.4\n\nUPDATED`, or `KO`. */
export function readDuckDnsAnswer(text: string): UpdateResult {
  const lines = text.trim().split(/\r?\n/)

  if (lines[0] === "OK") {
    return { ok: true, ip: parsePublicIpv4(lines[1] ?? "") ?? undefined }
  }

  if (lines[0] === "KO") {
    return {
      ok: false,
      hard: true,
      message:
        "DuckDNS refused the update: check the name and the token on duckdns.org.",
    }
  }

  return {
    ok: false,
    hard: false,
    message: `DuckDNS answered “${clip(text)}”. PCP will try again.`,
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

/** A request for the custom provider: the URL filled in, any login moved to a header. */
export function customRequest(
  config: Extract<DdnsConfig, { provider: "custom" }>,
  ip: string | null,
): { url: string; headers: Record<string, string> } {
  const url = new URL(fillTemplate(config.url, ip ?? "", config.hostname))
  const headers: Record<string, string> = { "user-agent": USER_AGENT }

  // fetch refuses a URL with a login in it.
  if (url.username || url.password) {
    headers.authorization = basic(
      decodeURIComponent(url.username),
      decodeURIComponent(url.password),
    )
    url.username = ""
    url.password = ""
  }

  return { url: url.toString(), headers }
}

async function request(
  fetchFn: Fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetchFn(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

function refusedLogin(status: number): boolean {
  return status === 401 || status === 403
}

/** Tells the service the address (or lets it see it, when ip is null). */
export async function sendDdnsUpdate(
  config: DdnsConfig,
  ip: string | null,
  fetchFn: Fetch = fetch,
): Promise<UpdateResult> {
  try {
    switch (config.provider) {
      case "duckdns": {
        const url = new URL("https://www.duckdns.org/update")
        url.searchParams.set("domains", config.subdomain)
        url.searchParams.set("token", config.token)
        url.searchParams.set("ip", ip ?? "")
        url.searchParams.set("verbose", "true")
        const response = await request(fetchFn, url.toString())
        return readDuckDnsAnswer(await response.text())
      }

      case "dyndns2": {
        const url = new URL(`https://${config.server}/nic/update`)
        url.searchParams.set("hostname", config.hostname)
        if (ip) {
          url.searchParams.set("myip", ip)
        }
        const response = await request(fetchFn, url.toString(), {
          headers: { authorization: basic(config.username, config.password) },
        })

        if (refusedLogin(response.status)) {
          return { ok: false, hard: true, message: DYNDNS2_HARD.badauth }
        }

        return readDyndns2Answer(await response.text())
      }

      case "cloudflare":
        return await updateCloudflare(config, ip, fetchFn)

      case "custom": {
        const { url, headers } = customRequest(config, ip)
        const response = await request(fetchFn, url, { headers })

        if (refusedLogin(response.status)) {
          return {
            ok: false,
            hard: true,
            message: `The update address refused PCP (HTTP ${response.status}): check the login in it.`,
          }
        }

        if (!response.ok) {
          return {
            ok: false,
            hard: false,
            message: `The update address answered HTTP ${response.status}. PCP will try again.`,
          }
        }

        return { ok: true, ip: ip ?? undefined }
      }
    }
  } catch (error) {
    return {
      ok: false,
      hard: false,
      message: `PCP could not reach the service (${errorText(error)}). It will try again.`,
    }
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause
    return cause?.code ?? error.message
  }

  return String(error)
}

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4"

type CloudflareAnswer<T> = {
  success: boolean
  errors?: { message: string }[]
  result: T
}

async function updateCloudflare(
  config: Extract<DdnsConfig, { provider: "cloudflare" }>,
  ip: string | null,
  fetchFn: Fetch,
): Promise<UpdateResult> {
  if (!ip) {
    return {
      ok: false,
      hard: false,
      message:
        "PCP could not find this network's public address to give Cloudflare. It will try again.",
    }
  }

  const call = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<CloudflareAnswer<T> | UpdateResult> => {
    const response = await request(fetchFn, `${CLOUDFLARE_API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        "content-type": "application/json",
      },
    })

    if (refusedLogin(response.status)) {
      return {
        ok: false,
        hard: true,
        message:
          "Cloudflare refused the API token. It needs permission to edit DNS for this domain.",
      }
    }

    const answer = (await response
      .json()
      .catch(() => null)) as CloudflareAnswer<T> | null

    if (!answer?.success) {
      return {
        ok: false,
        hard: false,
        message: `Cloudflare answered: ${answer?.errors?.[0]?.message ?? `HTTP ${response.status}`}.`,
      }
    }

    return answer
  }

  const zones = await call<{ id: string }[]>(
    `/zones?name=${encodeURIComponent(config.zone)}`,
  )

  if ("ok" in zones) return zones

  const zoneId = zones.result[0]?.id

  if (!zoneId) {
    return {
      ok: false,
      hard: true,
      message: `Cloudflare has no domain ${config.zone} this token can see.`,
    }
  }

  const records = await call<{ id: string; content: string }[]>(
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(config.record)}`,
  )

  if ("ok" in records) return records

  const record = records.result[0]

  if (record?.content === ip) {
    return { ok: true, ip }
  }

  const written = record
    ? await call(`/zones/${zoneId}/dns_records/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: ip }),
      })
    : await call(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: "A",
          name: config.record,
          content: ip,
          ttl: 1,
          proxied: false,
        }),
      })

  if ("ok" in written) return written

  return { ok: true, ip }
}

// ---------------------------------------------------------------------------
// Deciding when

/**
 * One round: look the address up, and send an update if one is due (or if
 * `force`, after the owner saved). Returns the status to keep; reads and
 * writes nothing else, so it is tested with a fake fetch and clock.
 */
export async function runDdnsRound({
  config,
  status,
  now,
  force = false,
  fetchFn = fetch,
}: {
  config: DdnsConfig
  status: DdnsStatus
  now: Date
  force?: boolean
  fetchFn?: Fetch
}): Promise<DdnsStatus> {
  const next: DdnsStatus = { ...status, lastCheckedAt: now.toISOString() }

  if (next.stopped && !force) {
    return next
  }

  if (
    !force &&
    next.nextAttemptAt &&
    now.getTime() < Date.parse(next.nextAttemptAt)
  ) {
    return next
  }

  const ip = await lookupPublicIp(fetchFn)
  const since = next.lastUpdatedAt
    ? now.getTime() - Date.parse(next.lastUpdatedAt)
    : Infinity

  if (!ip && !detectsAddressItself(config)) {
    return {
      ...next,
      lastError:
        "PCP could not find this network's public address. It will look again in a few minutes.",
    }
  }

  const due =
    force ||
    (ip
      ? ip !== next.lastIp || since >= DDNS_REFRESH_MS
      : since >= DDNS_BLIND_INTERVAL_MS)

  if (!due) {
    return next
  }

  const result = await sendDdnsUpdate(config, ip, fetchFn)

  if (result.ok) {
    return {
      lastIp: result.ip ?? ip ?? next.lastIp,
      lastUpdatedAt: now.toISOString(),
      lastCheckedAt: now.toISOString(),
    }
  }

  if (result.hard) {
    return {
      ...next,
      lastError: result.message,
      stopped: result.message,
      failures: 0,
      nextAttemptAt: undefined,
    }
  }

  const failures = (next.failures ?? 0) + 1
  const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]

  return {
    ...next,
    lastError: result.message,
    stopped: undefined,
    failures,
    nextAttemptAt: new Date(now.getTime() + wait).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Stored settings

export async function getDdnsConfig(): Promise<DdnsConfig | null> {
  return getHostJson<DdnsConfig>(DDNS_CONFIG_KEY)
}

export async function getDdnsStatus(): Promise<DdnsStatus> {
  return (await getHostJson<DdnsStatus>(DDNS_STATUS_KEY)) ?? {}
}

export async function saveDdnsStatus(status: DdnsStatus): Promise<void> {
  await setHostJson(DDNS_STATUS_KEY, status)
}

/** Saves new settings; a new start for the status (and a lifted stop). */
export async function saveDdnsConfig(input: DdnsInput): Promise<DdnsConfig> {
  const config = parseDdnsInput(input, await getDdnsConfig())
  await setHostJson(DDNS_CONFIG_KEY, config)
  await setHostJson(DDNS_STATUS_KEY, null)
  return config
}

export async function clearDdnsConfig(): Promise<void> {
  await setHostJson(DDNS_CONFIG_KEY, null)
  await setHostJson(DDNS_STATUS_KEY, null)
}

/** What the settings page shows: the settings without any credential. */
export type DdnsView = {
  provider: DdnsProvider
  name: string | null
  subdomain?: string
  server?: string
  hostname?: string
  username?: string
  zone?: string
  record?: string
  /** Only the address's host: the URL itself may carry a token. */
  urlHost?: string
}

export function ddnsView(config: DdnsConfig | null): DdnsView | null {
  if (!config) {
    return null
  }

  const name = ddnsHostname(config)

  switch (config.provider) {
    case "duckdns":
      return { provider: config.provider, name, subdomain: config.subdomain }
    case "dyndns2":
      return {
        provider: config.provider,
        name,
        server: config.server,
        hostname: config.hostname,
        username: config.username,
      }
    case "cloudflare":
      return {
        provider: config.provider,
        name,
        zone: config.zone,
        record: config.record,
      }
    case "custom": {
      let urlHost: string | undefined

      try {
        urlHost = new URL(fillTemplate(config.url, "", "")).host
      } catch {
        urlHost = undefined
      }

      return {
        provider: config.provider,
        name,
        hostname: config.hostname,
        urlHost,
      }
    }
  }
}
