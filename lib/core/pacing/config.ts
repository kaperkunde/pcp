import { z } from "zod"

import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, notFound } from "../errors"
import { normalizeSite } from "../fetch/rules"
import { getSetting, setSetting } from "../settings"
import {
  ASSISTANT_PACE_BOUNDS,
  BROWSER_PACING_CLASSES,
  MAX_ASSISTANT_PACE_MS,
  MAX_PACED_SERVERS,
  MAX_PACED_SITES,
  PACING_BOUNDS,
  PACING_CLASSES,
  PACING_DEFAULTS,
  rangePolicy,
  type BrowserPacingClass,
  type PaceRange,
  type PacingClass,
  type PacingOverride,
  type PacingPolicy,
} from "./limits"
import { checkPaceRange } from "./input"

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
 *
 * A browser action may also carry a pace of its own (resolveBrowserPolicy):
 * its tab's, which an assistant set (browser/tab-pace.ts), or else the one
 * the wrapper whose run made it declared. That comes before the server's
 * and the class's, but never below the owner's own pace for the site,
 * which stays a floor. What an assistant may set without asking is held
 * to the owner's bounds (`assistant`, by class; ASSISTANT_PACE_BOUNDS where
 * they set none).
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
  /**
   * What an assistant may give a tab or a wrapper without asking, by the
   * browser's classes: the owner's own bounds, where they set them.
   */
  assistant: Partial<Record<BrowserPacingClass, PaceRange>>
  /**
   * Classes and bounds a newer PCP wrote, which this one does not know:
   * never followed, but carried through every write, so a restore here
   * and back loses nothing.
   */
  unknown?: {
    classes: Record<string, PacingOverride>
    assistant: Record<string, PaceRange>
  }
}

export const EMPTY_PACING: PacingConfig = {
  classes: {},
  servers: {},
  sites: [],
  assistant: {},
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

const RangeSchema = z
  .strictObject({
    minMs: z.number().int().min(0).max(MAX_ASSISTANT_PACE_MS),
    maxMs: z.number().int().min(0).max(MAX_ASSISTANT_PACE_MS),
  })
  .refine((range) => range.minMs <= range.maxMs)

const ConfigSchema = z.strictObject({
  // By any name, so a class a newer PCP added (an export restored here)
  // does not cost the rest: readPacingConfig keeps the ones this PCP has.
  classes: z.record(z.string().min(1).max(64), OverrideSchema),
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
  // Left out by a PCP from before assistants could set a pace; by any
  // name, as classes are.
  assistant: z.record(z.string().min(1).max(64), RangeSchema).optional(),
})

/** Splits what this PCP knows from what a newer one wrote. */
function known(parsed: z.infer<typeof ConfigSchema>): PacingConfig {
  const classes: PacingConfig["classes"] = {}
  const assistant: PacingConfig["assistant"] = {}
  const unknown: NonNullable<PacingConfig["unknown"]> = {
    classes: {},
    assistant: {},
  }

  for (const [name, override] of Object.entries(parsed.classes)) {
    if ((PACING_CLASSES as readonly string[]).includes(name)) {
      classes[name as PacingClass] = override
    } else {
      unknown.classes[name] = override
    }
  }

  for (const [name, range] of Object.entries(parsed.assistant ?? {})) {
    if ((BROWSER_PACING_CLASSES as readonly string[]).includes(name)) {
      assistant[name as BrowserPacingClass] = range
    } else {
      unknown.assistant[name] = range
    }
  }

  return {
    classes,
    servers: parsed.servers,
    sites: parsed.sites,
    assistant,
    ...(Object.keys(unknown.classes).length > 0 ||
    Object.keys(unknown.assistant).length > 0
      ? { unknown }
      : {}),
  }
}

/**
 * The vault's pacing settings, sealed under its key (lib/core/settings.ts).
 * Read on every paced call; a value that does not read as one (a
 * hand-edited export) counts as none, which is PCP's defaults.
 */
export async function readPacingConfig(
  ctx: VaultContext,
): Promise<PacingConfig> {
  const raw = await getSetting(ctx, SETTING_PACING)

  if (!raw) {
    return EMPTY_PACING
  }

  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(raw))
    return parsed.success ? known(parsed.data) : EMPTY_PACING
  } catch {
    return EMPTY_PACING
  }
}

async function writePacingConfig(
  ctx: VaultContext,
  config: PacingConfig,
): Promise<void> {
  // What a newer PCP wrote goes back as it was, beside this one's.
  const stored = {
    classes: { ...config.unknown?.classes, ...config.classes },
    servers: config.servers,
    sites: config.sites,
    assistant: { ...config.unknown?.assistant, ...config.assistant },
  }
  const empty =
    Object.keys(stored.classes).length === 0 &&
    Object.keys(stored.servers).length === 0 &&
    stored.sites.length === 0 &&
    Object.keys(stored.assistant).length === 0

  await setSetting(
    ctx,
    SETTING_PACING,
    empty ? null : JSON.stringify(ConfigSchema.parse(stored)),
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

  const config = await readPacingConfig(ctx)
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
  const config = await readPacingConfig(ctx)
  await writePacingConfig(ctx, {
    ...config,
    classes: {},
    // Every class: a newer PCP's too.
    ...(config.unknown ? { unknown: { ...config.unknown, classes: {} } } : {}),
  })
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

  const config = await readPacingConfig(ctx)
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
  const config = await readPacingConfig(ctx)
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
  const config = await readPacingConfig(ctx)
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

/**
 * What an assistant may give a tab or a wrapper without asking, by class:
 * the owner's bounds, else PCP's.
 */
export function assistantBounds(
  config: Pick<PacingConfig, "assistant">,
): Record<BrowserPacingClass, PaceRange> {
  return {
    browser_act:
      config.assistant.browser_act ?? ASSISTANT_PACE_BOUNDS.browser_act,
    browser_navigate:
      config.assistant.browser_navigate ??
      ASSISTANT_PACE_BOUNDS.browser_navigate,
  }
}

/**
 * The owner's bounds for what assistants may set, by class, each checked;
 * null puts a class back to PCP's. One the same as PCP's is stored as none.
 */
export async function setAssistantPaceBounds(
  ctx: VaultContext,
  values: Partial<Record<BrowserPacingClass, PaceRange | null>>,
): Promise<void> {
  const config = await readPacingConfig(ctx)
  const assistant = { ...config.assistant }

  for (const [name, value] of Object.entries(values)) {
    const pacingClass = name as BrowserPacingClass

    if (!BROWSER_PACING_CLASSES.includes(pacingClass)) {
      throw invalid("There is no such kind of browser action.")
    }

    if (value == null) {
      delete assistant[pacingClass]
      continue
    }

    const checked = checkPaceRange(
      value,
      pacingClass === "browser_act"
        ? "what assistants may set for actions in a page"
        : "what assistants may set for opening a page",
    )

    if (
      checked.minMs === ASSISTANT_PACE_BOUNDS[pacingClass].minMs &&
      checked.maxMs === ASSISTANT_PACE_BOUNDS[pacingClass].maxMs
    ) {
      delete assistant[pacingClass]
    } else {
      assistant[pacingClass] = checked
    }
  }

  await writePacingConfig(ctx, { ...config, assistant })
}

/**
 * `pace` held up to `floor`: neither its shortest nor its longest wait
 * below the floor's, and the floor's burst cap kept.
 */
function atLeast(pace: PacingPolicy, floor: PacingPolicy): PacingPolicy {
  const minIntervalMs = Math.max(pace.minIntervalMs, floor.minIntervalMs)
  const longest = Math.max(
    pace.minIntervalMs + pace.jitterMs,
    floor.minIntervalMs + floor.jitterMs,
  )

  return {
    minIntervalMs,
    jitterMs: longest - minIntervalMs,
    burst: floor.burst ?? pace.burst,
  }
}

/**
 * What a browser action follows. `own` is the action's own pace, when it
 * has one (its tab's, else its wrapper's): it comes before the server's and
 * the class's, but the owner's pace for the site stays a floor under it.
 * Without one, as resolvePolicy.
 */
export function resolveBrowserPolicy(
  config: PacingConfig,
  pacingClass: BrowserPacingClass,
  where: { serverId?: string; site?: string; own?: PaceRange | null },
): PacingPolicy | null {
  if (!where.own) {
    return resolvePolicy(config, pacingClass, where)
  }

  const policy = rangePolicy(where.own)
  const site = where.site ? siteOverride(config.sites, where.site) : null

  return site && site.pace !== "unpaced" ? atLeast(policy, site.pace) : policy
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
  /** What assistants may set for a tab or a wrapper without asking. */
  assistant: Record<BrowserPacingClass, { range: PaceRange; own: boolean }>
  assistantDefaults: Record<BrowserPacingClass, PaceRange>
  /** The longest wait any of those ranges may go to. */
  assistantMaxMs: number
}

export async function pacingOverview(
  ctx: VaultContext,
): Promise<PacingOverview> {
  const config = await readPacingConfig(ctx)
  const classes = {} as PacingOverview["classes"]

  for (const name of PACING_CLASSES) {
    const own = config.classes[name]
    classes[name] = { pace: own ?? PACING_DEFAULTS[name], own: own != null }
  }

  const bounds = assistantBounds(config)

  return {
    defaults: PACING_DEFAULTS,
    classes,
    sites: config.sites,
    bounds: PACING_BOUNDS,
    assistant: {
      browser_act: {
        range: bounds.browser_act,
        own: config.assistant.browser_act != null,
      },
      browser_navigate: {
        range: bounds.browser_navigate,
        own: config.assistant.browser_navigate != null,
      },
    },
    assistantDefaults: ASSISTANT_PACE_BOUNDS,
    assistantMaxMs: MAX_ASSISTANT_PACE_MS,
  }
}

/** One server's pace as its page shows it. */
export async function serverPacing(
  ctx: VaultContext,
  serverId: string,
): Promise<PacingOverride | null> {
  return (await readPacingConfig(ctx)).servers[serverId] ?? null
}
