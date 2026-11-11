import { z } from "zod"

import { accessKey, listTokenToolAccess, parseToolAccess } from "./tool-access"
import {
  checkAccessLevels,
  checkAccessTiers,
  countByLevel,
  countByTier,
  matcher,
  writeAccessLevels,
  writeAccessTiers,
  type AccessLevel,
  type AccessTier,
} from "./access-requests"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  TOOL_TIER_LABELS,
  TOOL_TIERS,
  type ToolAccess,
  type ToolTier,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, isPcpError } from "./errors"
import { isToolTier } from "./tool-tiers"

/**
 * Levels and tiers an assistant proposes with a new or changed server
 * (`tool_access` on register_server, create_wrapper and update_wrapper).
 * They are a proposal only, as propose_tool_access's are
 * (access-requests.ts): stored on the permission request, shown filled in
 * and editable on the same page as the approval, and written only by the
 * owner's yes there, with what they left on the page. A level is the
 * calling token's own (writeAccessLevels); a tier goes through setToolTier,
 * on the definition, so every server of it takes it.
 *
 * Where the tools' names are known before the server exists (a wrapper's
 * tools, an API endpoint's operations, a mail or calendar account's fixed
 * tools) the owner sets each tool. Where they are not (an MCP server by its
 * address, one that signs in with OAuth, what a service registers) the
 * owner sees and saves name patterns, kept on the server (`pendingAccess`)
 * and applied once to the tools its first read finds, then cleared.
 */

/** One rule: a tool's exact name or a pattern with `*`, a level, a tier. */
export type AccessRule = {
  pattern: string
  access?: ToolAccess
  tier?: ToolTier
}

/** A tool the owner sets, by name, when the names are known up front. */
export type KnownTool = { name: string; title?: string | null }

/** What a request carries of the assistant's proposal. */
export type ProposedAccess = {
  /**
   * The tools it will have, when known before it exists: the rules are then
   * one per tool, by exact name. Absent: the rules are name patterns,
   * applied once to the tools found when it is first read.
   */
  tools?: KnownTool[]
  rules: AccessRule[]
}

/** tool_access as the gateway takes it. */
export type ToolAccessArg = Array<{
  tools?: string[]
  access?: ToolAccess
  tier?: ToolTier
}>

/** The most entries in tool_access, and patterns the owner may save. */
export const MAX_ACCESS_RULES = 100
/** The most names or patterns in one entry. */
export const MAX_RULE_PATTERNS = 200
/** A pattern's length: a tool's name is at most this, too, in practice. */
export const MAX_PATTERN_CHARS = 200

const PATTERN = /^[^\s\u0000-\u001f\u007f]+$/

/** tool_access's schema, the same on every tool that takes it. */
export const TOOL_ACCESS_ARG = z
  .array(
    z
      .object({
        tools: z
          .array(z.string().min(1).max(MAX_PATTERN_CHARS))
          .min(1)
          .max(MAX_RULE_PATTERNS)
          .optional()
          .describe(
            'Tool names, or patterns with * ("list_*", "*_invoice"). Leave out for every tool.',
          ),
        access: z
          .enum(TOOL_ACCESS_LEVELS)
          .optional()
          .describe(
            'The level for this token: "allowed" (runs without asking), "ask" (asks the owner first) or "blocked" (hidden from you).',
          ),
        tier: z
          .enum(TOOL_TIERS)
          .optional()
          .describe(
            'How much the tool can do: "read", "write" (changes things, deletes nothing for good) or "destructive". It decides the execute_* entry that runs it, and is every token\'s.',
          ),
      })
      // An entry sets a level, a tier, or both.
      .meta({
        allOf: [{ anyOf: [{ required: ["access"] }, { required: ["tier"] }] }],
      }),
  )
  .min(1)
  .max(MAX_ACCESS_RULES)
  .optional()
  .describe(
    "Levels and tiers to propose for its tools, which the owner sees filled in beside the approval, can change, and saves with it; nothing is set unless they agree. Applied in order; a later entry wins. Left out, its tools ask the owner first, as a new server's do.",
  )

function checkPattern(pattern: unknown): string {
  if (
    typeof pattern !== "string" ||
    pattern.length > MAX_PATTERN_CHARS ||
    !PATTERN.test(pattern)
  ) {
    throw invalid(
      `A tool name or pattern is one word of at most ${MAX_PATTERN_CHARS} characters, with * for any run of characters.`,
    )
  }

  return pattern
}

function readRuleFields(entry: {
  access?: unknown
  tier?: unknown
}): Omit<AccessRule, "pattern"> {
  const fields: Omit<AccessRule, "pattern"> = {}

  if (entry.access !== undefined && entry.access !== null) {
    fields.access = parseToolAccess(String(entry.access))
  }

  if (entry.tier !== undefined && entry.tier !== null) {
    if (!isToolTier(entry.tier)) {
      throw invalid(
        `"${String(entry.tier)}" is not a tier. Use read, write or destructive.`,
      )
    }

    fields.tier = entry.tier
  }

  return fields
}

/** Later fields win over earlier ones; a rule that sets nothing is dropped. */
function mergeRules(rules: AccessRule[]): AccessRule[] {
  const merged = new Map<string, AccessRule>()

  for (const rule of rules) {
    const before = merged.get(rule.pattern)
    merged.set(rule.pattern, {
      pattern: rule.pattern,
      ...((rule.access ?? before?.access)
        ? { access: rule.access ?? before?.access }
        : {}),
      ...((rule.tier ?? before?.tier)
        ? { tier: rule.tier ?? before?.tier }
        : {}),
    })
  }

  return [...merged.values()].filter(
    (rule) => rule.access !== undefined || rule.tier !== undefined,
  )
}

/**
 * What each tool gets of the rules: later rules win, field by field, so a
 * pattern can set every tool and an exact name its exception.
 */
export function resolveAccessRules(
  rules: AccessRule[],
  names: string[],
): Map<string, Omit<AccessRule, "pattern">> {
  const tests = rules.map((rule) => ({ rule, test: matcher(rule.pattern) }))
  const resolved = new Map<string, Omit<AccessRule, "pattern">>()

  for (const name of names) {
    const fields: Omit<AccessRule, "pattern"> = {}

    for (const { rule, test } of tests) {
      if (test(name)) {
        if (rule.access) {
          fields.access = rule.access
        }

        if (rule.tier) {
          fields.tier = rule.tier
        }
      }
    }

    if (fields.access || fields.tier) {
      resolved.set(name, fields)
    }
  }

  return resolved
}

/**
 * The assistant's tool_access, read for a request: one rule per tool where
 * the tools are known (`tools`), patterns where they are not. Tools hidden
 * from the token (blocked) are left out of what it can name, as with
 * propose_tool_access; unblocking one is the owner's. Null when it sent
 * none.
 */
export function proposeToolAccess(
  arg: ToolAccessArg | undefined,
  {
    tools,
    hidden = new Set(),
    label,
  }: {
    tools?: KnownTool[]
    /** Tools of a server it changes that this token has blocked. */
    hidden?: Set<string>
    /** What the refusal calls it: "The wrapper", "The API". */
    label: string
  },
): ProposedAccess | null {
  if (arg === undefined) {
    return null
  }

  if (!Array.isArray(arg) || arg.length === 0) {
    throw invalid("tool_access needs at least one entry, or leave it out.")
  }

  if (arg.length > MAX_ACCESS_RULES) {
    throw invalid(
      `tool_access takes at most ${MAX_ACCESS_RULES} entries; use patterns such as "list_*".`,
    )
  }

  const rules: AccessRule[] = []

  for (const entry of arg) {
    const fields = readRuleFields(entry)

    if (!fields.access && !fields.tier) {
      throw invalid(
        "Give each tool_access entry an access level, a tier, or both.",
      )
    }

    const patterns = entry.tools ?? ["*"]

    if (patterns.length > MAX_RULE_PATTERNS) {
      throw invalid(
        `At most ${MAX_RULE_PATTERNS} tool names in one tool_access entry; use patterns such as "list_*".`,
      )
    }

    for (const pattern of patterns) {
      rules.push({ pattern: checkPattern(pattern), ...fields })
    }
  }

  if (!tools) {
    const merged = mergeRules(rules)

    if (merged.length > MAX_RULE_PATTERNS) {
      throw invalid(
        `tool_access names at most ${MAX_RULE_PATTERNS} patterns in all; use patterns such as "list_*".`,
      )
    }

    return { rules: merged }
  }

  const visible = tools.filter((tool) => !hidden.has(tool.name))
  const unmatched = [
    ...new Set(
      rules
        .filter(
          (rule) => !visible.some((tool) => matcher(rule.pattern)(tool.name)),
        )
        .map((rule) => rule.pattern),
    ),
  ]

  if (unmatched.length > 0) {
    throw invalid(
      `${label} has no tool matching ${unmatched
        .slice(0, 5)
        .map((pattern) => `"${pattern}"`)
        .join(
          ", ",
        )}${unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : ""} in tool_access. Its tools: ${visible
        .slice(0, 30)
        .map((tool) => tool.name)
        .join(", ")}${visible.length > 30 ? ", …" : ""}.`,
    )
  }

  const resolved = resolveAccessRules(
    rules,
    visible.map((tool) => tool.name),
  )

  return {
    tools,
    rules: visible.flatMap((tool) => {
      const fields = resolved.get(tool.name)
      return fields ? [{ pattern: tool.name, ...fields }] : []
    }),
  }
}

/**
 * The owner's levels and tiers as the page sends them with their yes,
 * checked against the request: by a tool's exact name where the tools are
 * known, as patterns where they are not. Throws on anything else.
 */
export function checkChosenAccess(
  proposal: ProposedAccess,
  chosen: unknown,
): AccessRule[] {
  if (!Array.isArray(chosen)) {
    throw invalid("Send the levels and tiers as a list.")
  }

  const known = proposal.tools
    ? new Set(proposal.tools.map((tool) => tool.name))
    : null
  const most = known ? known.size : MAX_RULE_PATTERNS

  if (chosen.length > most) {
    throw invalid("That is more levels and tiers than this request has tools.")
  }

  const rules: AccessRule[] = []

  for (const entry of chosen as unknown[]) {
    const { pattern, access, tier } = (entry ?? {}) as Record<string, unknown>
    const checked = checkPattern(
      typeof pattern === "string" ? pattern.trim() : pattern,
    )

    if (known && !known.has(checked)) {
      throw invalid(`${checked} is not one of its tools.`)
    }

    rules.push({
      pattern: checked,
      ...readRuleFields({
        access: access === "" ? undefined : access,
        tier: tier === "" ? undefined : tier,
      }),
    })
  }

  return mergeRules(rules)
}

/** "a tool" or "3 tools". */
function tools(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`
}

/** The line an approval page has on what its tools start at. */
export function askFirstLine(proposed: boolean): string {
  return proposed
    ? "Its tools ask you first, for every token, as a new server's do, except where you set a level below"
    : "Its tools ask you first, for every token, as a new server's do"
}

/**
 * What the owner (and the assistant, reading its request) is told of the
 * proposal: whose levels, and when they apply.
 */
export function proposedAccessLine(
  proposal: ProposedAccess,
  tokenName: string,
): string {
  const levels = proposal.rules.filter((rule) => rule.access).length
  const tiers = proposal.rules.filter((rule) => rule.tier).length
  const what = proposal.tools
    ? [
        ...(levels > 0
          ? [
              `levels for ${tools(levels)}: ${countByLevel(proposal.rules.flatMap((rule) => (rule.access ? [{ access: rule.access }] : [])))}`,
            ]
          : []),
        ...(tiers > 0
          ? [
              `tiers for ${tools(tiers)}: ${countByTier(proposal.rules.flatMap((rule) => (rule.tier ? [{ tier: rule.tier }] : [])))}`,
            ]
          : []),
      ].join("; ")
    : proposal.rules
        .map(
          (rule) =>
            `${rule.pattern} → ${[
              ...(rule.access ? [TOOL_ACCESS_LABELS[rule.access]] : []),
              ...(rule.tier ? [TOOL_TIER_LABELS[rule.tier]] : []),
            ].join(", ")}`,
        )
        .join("; ")

  return proposal.tools
    ? `The assistant proposes ${what}. They are filled in below: the levels are for the token "${tokenName}" only, a tier is every token's and every server's of the same definition. Your yes saves what you leave there, and nothing else`
    : `The assistant proposes levels and tiers by tool name, as its tools are not known until PCP first reads them: ${what}. They are filled in below: the levels are for the token "${tokenName}" only, a tier is every token's and every server's of the same definition. Your yes saves what you leave there, applied once to the tools PCP first reads from it`
}

/**
 * Writes the owner's rules to the tools a server has now, through the same
 * checks and writes as a saved access request (access-requests.ts): levels
 * for the token, tiers through setToolTier. `keepBlocked` leaves alone a
 * tool the token has blocked by now (the owner's later word), for rules
 * applied after the approval.
 */
export async function applyAccessRules(
  ctx: VaultContext,
  {
    serverId,
    tokenId,
    rules,
    keepBlocked = false,
  }: {
    serverId: string
    tokenId: string
    rules: AccessRule[]
    keepBlocked?: boolean
  },
): Promise<{ levels: AccessLevel[]; tiers: AccessTier[] }> {
  const reached = (await listTokenToolAccess(ctx, tokenId)).find(
    (server) => server.id === serverId,
  )

  if (!reached) {
    return { levels: [], tiers: [] }
  }

  const resolved = resolveAccessRules(
    rules,
    reached.tools.map((tool) => tool.name),
  )
  const blocked = new Set(
    reached.tools
      .filter((tool) => tool.access === "blocked")
      .map((tool) => accessKey(serverId, tool.name)),
  )
  const levels: AccessLevel[] = []
  const tiers: AccessTier[] = []

  for (const [tool, fields] of resolved) {
    if (
      fields.access &&
      !(keepBlocked && blocked.has(accessKey(serverId, tool)))
    ) {
      levels.push({ serverId, tool, access: fields.access })
    }

    if (fields.tier) {
      tiers.push({ serverId, tool, tier: fields.tier })
    }
  }

  const checkedLevels = await checkAccessLevels(ctx, tokenId, levels)
  const checkedTiers = await checkAccessTiers(ctx, tokenId, tiers)

  if (checkedLevels.length > 0) {
    await writeAccessLevels(ctx, tokenId, checkedLevels)
  }

  await writeAccessTiers(ctx, checkedTiers)

  return { levels: checkedLevels, tiers: checkedTiers }
}

/** What the assistant hears of the levels and tiers written. */
function describeWritten(written: {
  levels: AccessLevel[]
  tiers: AccessTier[]
}): string {
  if (written.levels.length === 0 && written.tiers.length === 0) {
    return "The owner set no level or tier for its tools: they ask the owner the first time they are used."
  }

  return [
    ...(written.levels.length > 0
      ? [
          `The owner set this token's level for ${tools(written.levels.length)} (${countByLevel(written.levels)}); the others ask the owner the first time they are used.`,
        ]
      : ["Its tools ask the owner the first time they are used."]),
    ...(written.tiers.length > 0
      ? [
          `They set the tier of ${tools(written.tiers.length)} (${countByTier(written.tiers)}).`,
        ]
      : []),
  ].join(" ")
}

/**
 * The owner's rules for a server their yes just made or changed: written at
 * once to the tools it has, or, while it has none yet (its tools not read,
 * an OAuth sign-in waiting), kept on the server and applied once to the
 * tools its first read finds. Returns what the assistant is told.
 */
export async function settleChosenAccess(
  ctx: VaultContext,
  {
    serverId,
    tokenId,
    rules,
  }: { serverId: string; tokenId: string; rules: AccessRule[] },
): Promise<string> {
  if (rules.length === 0) {
    return ""
  }

  const held = await db().mcpTool.count({ where: { serverId } })

  if (held > 0) {
    return describeWritten(
      await applyAccessRules(ctx, { serverId, tokenId, rules }),
    )
  }

  await db().mcpServer.update({
    where: { id: serverId },
    data: { pendingAccess: JSON.stringify({ tokenId, rules }) },
  })

  return "The owner saved levels and tiers for its tools by name; they apply once, to the tools PCP first reads from it."
}

function readPending(
  stored: string,
): { tokenId: string; rules: AccessRule[] } | null {
  try {
    const value = JSON.parse(stored) as {
      tokenId?: unknown
      rules?: unknown
    }

    if (typeof value.tokenId !== "string" || !Array.isArray(value.rules)) {
      return null
    }

    return {
      tokenId: value.tokenId,
      rules: checkChosenAccess({ rules: [] }, value.rules),
    }
  } catch {
    return null
  }
}

/**
 * After a read of a server's tools: the rules the owner saved with their
 * approval, applied once to the tools it found, then cleared. Whoever
 * clears them applies them, however many reads race. A token gone or
 * revoked since, or no longer reaching the server, gets nothing; a tool it
 * has blocked by now keeps its block.
 */
export async function applyPendingAccess(
  ctx: VaultContext,
  serverId: string,
): Promise<void> {
  const row = await db().mcpServer.findFirst({
    where: { id: serverId, vaultId: ctx.vaultId },
    select: { pendingAccess: true },
  })

  if (!row?.pendingAccess) {
    return
  }

  if ((await db().mcpTool.count({ where: { serverId } })) === 0) {
    return
  }

  const cleared = await db().mcpServer.updateMany({
    where: { id: serverId, pendingAccess: row.pendingAccess },
    data: { pendingAccess: null },
  })

  if (cleared.count !== 1) {
    return
  }

  const pending = readPending(row.pendingAccess)

  if (!pending) {
    return
  }

  const token = await db().apiToken.findFirst({
    where: { id: pending.tokenId, vaultId: ctx.vaultId, revokedAt: null },
    select: { id: true },
  })

  if (!token) {
    return
  }

  try {
    await applyAccessRules(ctx, {
      serverId,
      tokenId: pending.tokenId,
      rules: pending.rules,
      keepBlocked: true,
    })
  } catch (error) {
    if (!isPcpError(error)) {
      console.error("[proposed-access] applying saved levels failed", {
        serverId,
        error,
      })
    }
  }
}

/** What the approval page shows of a proposal, for its editor. */
export type ProposedAccessShown = {
  /** Set each tool by name; absent: patterns. */
  tools: KnownTool[] | null
  rules: AccessRule[]
  tokenName: string
}

export function proposedAccessShown(
  proposal: ProposedAccess,
  tokenName: string,
): ProposedAccessShown {
  return { tools: proposal.tools ?? null, rules: proposal.rules, tokenName }
}
