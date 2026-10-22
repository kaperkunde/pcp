import { z } from "zod"

import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, notFound } from "../errors"
import { normalizeSite } from "../fetch/rules"
import { getVaultSetting, setSetting } from "../settings"
import {
  MAX_PACED_SERVERS,
  MAX_PACED_SITES,
  PACING_BOUNDS,
  PACING_CLASSES,
  PACING_DEFAULTS,
  type PacingClass,
  type PacingOverride,
  type PacingPolicy,
} from "./limits"

/**
 * The owner's own pace (Settings → Pacing, a server's Advanced), kept as
 * the vault's setting SETTING_PACING: it names the owner's sites and
 * servers, so it is the vault's, never the machine's, and travels with an
 * export like the vault's other settings. It holds overrides only; what
 * the owner did not set follows PCP's defaults (limits.ts), so a better
 * default reaches them.
 *
 * What a call follows, most specific first: the site's override (the host
 * itself, or a parent the owner marked as covering its subdomains), then
 * the server's, then the class's, then PCP's default for the class.
 */

export const SETTING_PACING = "pacing"

export type PacedSite = {
  /** As siteKey writes it: the host, and a port that is not the default. */
  host: string
  /** Also every host under it (www.example.com for example.com). */
  subdomains: boolean
  pace: PacingOverride
}

export type PacingConfig = {
  classes: Partial<Record<PacingClass, PacingOverride>>
  /** By server id. */
  servers: Record<string, PacingOverride>
  sites: PacedSite[]
}

export const EMPTY_PACING: PacingConfig = {
  classes: {},
  servers: {},
  sites: [],
}

const bounded = (bound: { min: number; max: number }) =>
  z.number().int().min(bound.min).max(bound.max)

const PolicySchema = z.strictObject({
  minIntervalMs: bounded(PACING_BOUNDS.minIntervalMs),
  jitterMs: bounded(PACING_BOUNDS.jitterMs),
  burst: z
    .strictObject({
      max: bounded(PACING_BOUNDS.burstMax),
      perMs: bounded(PACING_BOUNDS.burstPerMs),
    })
    .nullable(),
})

const OverrideSchema = z.union([z.literal("unpaced"), PolicySchema])

const ConfigSchema = z.strictObject({
  classes: z.partialRecord(z.enum(PACING_CLASSES), OverrideSchema),
  servers: z.record(z.string().min(1).max(100), OverrideSchema),
  sites: z
    .array(
      z.strictObject({
        host: z.string().min(1).max(300),
        subdomains: z.boolean(),
        pace: OverrideSchema,
      }),
    )
    .max(MAX_PACED_SITES),
})

/**
 * The vault's pacing settings. Read on every paced call, without the vault
 * key (settings are not encrypted); a value that does not read as one (a
 * hand-edited export) counts as none, which is PCP's defaults.
 */
export async function readPacingConfig(vaultId: string): Promise<PacingConfig> {
  const raw = await getVaultSetting(vaultId, SETTING_PACING)

  if (!raw) {
    return EMPTY_PACING
  }

  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : EMPTY_PACING
  } catch {
    return EMPTY_PACING
  }
}

async function writePacingConfig(
  ctx: VaultContext,
  config: PacingConfig,
): Promise<void> {
  const empty =
    Object.keys(config.classes).length === 0 &&
    Object.keys(config.servers).length === 0 &&
    config.sites.length === 0

  await setSetting(
    ctx,
    SETTING_PACING,
    empty ? null : JSON.stringify(ConfigSchema.parse(config)),
  )
}

function seconds(ms: number): string {
  return `${ms / 1000} s`
}

/** An override as the owner set it, held to PACING_BOUNDS. */
export function checkOverride(value: PacingOverride): PacingOverride {
  if (value === "unpaced") {
    return value
  }

  const { minIntervalMs, jitterMs, burst } = value
  const whole = (
    name: string,
    ms: number,
    bound: { min: number; max: number },
  ) => {
    if (!Number.isFinite(ms) || ms < bound.min || ms > bound.max) {
      throw invalid(
        `Keep ${name} between ${seconds(bound.min)} and ${seconds(bound.max)}.`,
      )
    }
    return Math.round(ms)
  }

  const policy: PacingPolicy = {
    minIntervalMs: whole(
      "the pause between actions",
      minIntervalMs,
      PACING_BOUNDS.minIntervalMs,
    ),
    jitterMs: whole("the random extra wait", jitterMs, PACING_BOUNDS.jitterMs),
    burst: null,
  }

  if (burst) {
    const { burstMax, burstPerMs } = PACING_BOUNDS

    if (
      !Number.isInteger(burst.max) ||
      burst.max < burstMax.min ||
      burst.max > burstMax.max
    ) {
      throw invalid(
        `Keep the number of actions between ${burstMax.min} and ${burstMax.max}, or leave it empty for no limit.`,
      )
    }

    if (
      !Number.isFinite(burst.perMs) ||
      burst.perMs < burstPerMs.min ||
      burst.perMs > burstPerMs.max
    ) {
      throw invalid(
        `Keep the time for that many actions between ${seconds(burstPerMs.min)} and ${burstPerMs.max / 3_600_000} hours.`,
      )
    }

    policy.burst = { max: burst.max, perMs: Math.round(burst.perMs) }
  }

  return policy
}

function samePolicy(a: PacingOverride, b: PacingOverride): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Classes' paces, each the owner's or null for PCP's default, checked
 * together and written at once. One the same as the default is stored as
 * none, so a better default reaches it.
 */
export async function setPacingClasses(
  ctx: VaultContext,
  values: Partial<Record<PacingClass, PacingOverride | null>>,
): Promise<void> {
  const checked = new Map<PacingClass, PacingOverride | null>()

  for (const [name, value] of Object.entries(values)) {
    const pacingClass = name as PacingClass

    if (!PACING_CLASSES.includes(pacingClass)) {
      throw invalid("There is no such kind of action.")
    }

    checked.set(pacingClass, value == null ? null : checkOverride(value))
  }

  const config = await readPacingConfig(ctx.vaultId)
  const classes = { ...config.classes }

  for (const [pacingClass, value] of checked) {
    if (value === null || samePolicy(value, PACING_DEFAULTS[pacingClass])) {
      delete classes[pacingClass]
    } else {
      classes[pacingClass] = value
    }
  }

  await writePacingConfig(ctx, { ...config, classes })
}

/** One class's pace, or null for PCP's default. */
export function setPacingClass(
  ctx: VaultContext,
  pacingClass: PacingClass,
  value: PacingOverride | null,
): Promise<void> {
  return setPacingClasses(ctx, { [pacingClass]: value })
}

/** Every class back to PCP's defaults; servers and sites stay. */
export async function resetPacingClasses(ctx: VaultContext): Promise<void> {
  const config = await readPacingConfig(ctx.vaultId)
  await writePacingConfig(ctx, { ...config, classes: {} })
}

/**
 * One server's pace, or null for the defaults of its kind. Servers no
 * longer in the vault are dropped as it is written.
 */
export async function setPacingServer(
  ctx: VaultContext,
  serverId: string,
  value: PacingOverride | null,
): Promise<void> {
  const ids = new Set(
    (
      await db().mcpServer.findMany({
        where: { vaultId: ctx.vaultId },
        select: { id: true },
      })
    ).map((row) => row.id),
  )

  if (!ids.has(serverId)) {
    throw notFound("That server")
  }

  const config = await readPacingConfig(ctx.vaultId)
  const servers: Record<string, PacingOverride> = {}

  for (const [id, override] of Object.entries(config.servers)) {
    if (ids.has(id) && id !== serverId) servers[id] = override
  }

  if (value !== null) {
    if (Object.keys(servers).length >= MAX_PACED_SERVERS) {
      throw invalid(
        `At most ${MAX_PACED_SERVERS} servers have a pace of their own.`,
      )
    }

    servers[serverId] = checkOverride(value)
  }

  await writePacingConfig(ctx, { ...config, servers })
}

/**
 * Adds or changes a site's pace. `replacing` is the site as it was, when
 * the owner changed its name; the site is written as normalizeSite reads
 * what they typed.
 */
export async function setPacingSite(
  ctx: VaultContext,
  input: { site: string; subdomains: boolean; pace: PacingOverride },
  replacing?: string,
): Promise<string> {
  const host = normalizeSite(input.site)
  const pace = checkOverride(input.pace)
  const config = await readPacingConfig(ctx.vaultId)
  const old = replacing ? normalizeSite(replacing) : null
  const sites = config.sites.filter(
    (site) => site.host !== host && site.host !== old,
  )

  if (sites.length >= MAX_PACED_SITES) {
    throw invalid(`At most ${MAX_PACED_SITES} sites have a pace of their own.`)
  }

  sites.push({ host, subdomains: input.subdomains, pace })
  sites.sort((a, b) => a.host.localeCompare(b.host))
  await writePacingConfig(ctx, { ...config, sites })
  return host
}

export async function removePacingSite(
  ctx: VaultContext,
  site: string,
): Promise<void> {
  const host = normalizeSite(site)
  const config = await readPacingConfig(ctx.vaultId)
  const sites = config.sites.filter((entry) => entry.host !== host)

  if (sites.length === config.sites.length) {
    throw notFound("That site")
  }

  await writePacingConfig(ctx, { ...config, sites })
}

function splitPort(host: string): { name: string; port: string } {
  const match = /^(.*?)(?::(\d+))?$/.exec(host)!
  return { name: match[1]!, port: match[2] ?? "" }
}

/**
 * The site override for a host: its own, or else the closest parent that
 * covers its subdomains (the same port either way).
 */
export function siteOverride(
  sites: PacedSite[],
  host: string,
): PacedSite | null {
  const exact = sites.find((site) => site.host === host)

  if (exact) {
    return exact
  }

  const target = splitPort(host)
  let best: PacedSite | null = null

  for (const site of sites) {
    if (!site.subdomains) continue
    const parent = splitPort(site.host)

    if (
      parent.port === target.port &&
      target.name.endsWith(`.${parent.name}`) &&
      (!best || site.host.length > best.host.length)
    ) {
      best = site
    }
  }

  return best
}

/** What a call follows; null when it is not paced. */
export function resolvePolicy(
  config: PacingConfig,
  pacingClass: PacingClass,
  where: { serverId?: string; site?: string },
): PacingPolicy | null {
  const site = where.site ? siteOverride(config.sites, where.site) : null
  const override =
    site?.pace ??
    (where.serverId ? config.servers[where.serverId] : undefined) ??
    config.classes[pacingClass] ??
    PACING_DEFAULTS[pacingClass]

  return override === "unpaced" ? null : override
}

/** What the Settings page shows. */
export type PacingOverview = {
  defaults: Record<PacingClass, PacingPolicy>
  /** What each class follows now: the owner's, or PCP's default. */
  classes: Record<PacingClass, { pace: PacingOverride; own: boolean }>
  sites: PacedSite[]
  bounds: typeof PACING_BOUNDS
}

export async function pacingOverview(
  ctx: VaultContext,
): Promise<PacingOverview> {
  const config = await readPacingConfig(ctx.vaultId)
  const classes = {} as PacingOverview["classes"]

  for (const name of PACING_CLASSES) {
    const own = config.classes[name]
    classes[name] = { pace: own ?? PACING_DEFAULTS[name], own: own != null }
  }

  return {
    defaults: PACING_DEFAULTS,
    classes,
    sites: config.sites,
    bounds: PACING_BOUNDS,
  }
}

/** One server's pace as its page shows it. */
export async function serverPacing(
  ctx: VaultContext,
  serverId: string,
): Promise<PacingOverride | null> {
  return (await readPacingConfig(ctx.vaultId)).servers[serverId] ?? null
}
