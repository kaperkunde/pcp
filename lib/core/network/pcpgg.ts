import { invalid } from "../errors"
import { getHostJson, setHostJson } from "../host-settings"
import { DEFAULT_RELAY_URL } from "./pcpgg/control"
import { clearTlsConfig, getTlsConfig, getTlsStatus } from "./tls"

/**
 * The connection to pcp.gg: a name of the owner's (you.pcp.gg) whose
 * connections pcp.gg carries to this computer over one connection PCP
 * opens itself (pcpgg/connector.ts), so nothing on the router has to change.
 * HTTPS still ends in PCP: it gets its own certificate for the name (tls.ts),
 * and pcp.gg passes on bytes it cannot read.
 *
 * The key is a host setting, stored unencrypted like the dynamic DNS login:
 * PCP stays connected while nobody is signed in. It is never exported
 * (backup-format.ts lists the host settings an export carries) and never
 * sent back to the browser.
 */

export const PCPGG_CONFIG_KEY = "pcpgg.config"
export const PCPGG_STATUS_KEY = "pcpgg.status"

export const PCPGG_KEY_PREFIX = "pcpgg_"
const KEY_PATTERN = /pcpgg_[A-Za-z0-9_-]{16,250}/

export type PcpggConfig = {
  key: string
  /** When the owner accepted Let's Encrypt's agreement for the name. */
  agreedAt: string
}

/** What outlives a restart: the name, and a key pcp.gg turned down. */
export type PcpggSaved = {
  name?: string
  /** Why pcp.gg refused the key; PCP does not try it again. */
  rejected?: string
  rejectedAt?: string
}

/** The pcp.gg address PCP connects to (PCP_PCPGG_RELAY_URL in tests). */
export function pcpggRelayUrl(): string {
  return process.env.PCP_PCPGG_RELAY_URL?.trim() || DEFAULT_RELAY_URL
}

/**
 * The key in what the owner pasted: the key alone, or a line that holds it
 * (the command pcp.gg shows for running the connector by hand).
 */
export function readPcpggKey(text: string): string | null {
  return KEY_PATTERN.exec(text)?.[0] ?? null
}

/** Enough of a key to tell two apart, as pcp.gg's dashboard shows it. */
export function pcpggKeyHint(key: string): string {
  return `${key.slice(0, PCPGG_KEY_PREFIX.length + 4)}…`
}

export function parsePcpggInput(
  input: { key: string; agreed: boolean },
  existing: PcpggConfig | null,
  now: Date,
): PcpggConfig {
  if (!input.agreed) {
    throw invalid(
      "PCP gets a certificate for your pcp.gg name from Let's Encrypt, which only issues one once you accept its agreement.",
    )
  }

  const typed = input.key.trim()

  if (!typed) {
    if (existing) {
      return { key: existing.key, agreedAt: now.toISOString() }
    }

    throw invalid("Paste the connection key from your pcp.gg dashboard.")
  }

  const key = readPcpggKey(typed)

  if (!key) {
    throw invalid(
      `That is not a pcp.gg connection key. Copy it from your pcp.gg dashboard: it starts with ${PCPGG_KEY_PREFIX}.`,
    )
  }

  return { key, agreedAt: now.toISOString() }
}

export async function getPcpggConfig(): Promise<PcpggConfig | null> {
  return getHostJson<PcpggConfig>(PCPGG_CONFIG_KEY)
}

export async function getPcpggSaved(): Promise<PcpggSaved> {
  return (await getHostJson<PcpggSaved>(PCPGG_STATUS_KEY)) ?? {}
}

export async function savePcpggSaved(saved: PcpggSaved): Promise<void> {
  await setHostJson(PCPGG_STATUS_KEY, saved)
}

/** A save is a fresh start: a key turned down before is tried again. */
export async function savePcpggConfig(
  input: { key: string; agreed: boolean },
  now = new Date(),
): Promise<PcpggConfig> {
  const config = parsePcpggInput(input, await getPcpggConfig(), now)
  const { name } = await getPcpggSaved()
  await setHostJson(PCPGG_CONFIG_KEY, config)
  await setHostJson(PCPGG_STATUS_KEY, name ? { name } : null)
  return config
}

/**
 * Turns pcp.gg off, and HTTPS for the pcp.gg name with it: the name no
 * longer leads here, and what Let's Encrypt said about it is no news for the
 * HTTPS card.
 */
export async function clearPcpggConfig(): Promise<void> {
  const [{ name }, tls, tlsStatus] = await Promise.all([
    getPcpggSaved(),
    getTlsConfig(),
    getTlsStatus(),
  ])

  if (tls?.via === "pcpgg" || (!tls && name && tlsStatus.domain === name)) {
    await clearTlsConfig()
  }

  await setHostJson(PCPGG_CONFIG_KEY, null)
  await setHostJson(PCPGG_STATUS_KEY, null)
}
