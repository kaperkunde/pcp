"use client"

import { Plus, X } from "lucide-react"
import { useState } from "react"

import { Badge } from "@kaperkunde/ui/badge"
import { Button } from "@kaperkunde/ui/button"
import { Input, Select } from "@kaperkunde/ui/input"
import { List, ListRow } from "@kaperkunde/ui/list"
import { Switch } from "@kaperkunde/ui/switch"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  TOOL_TIER_LABELS,
  TOOL_TIERS,
  type ToolAccess,
  type ToolTier,
} from "@/lib/core/constants"
import type {
  AccessRule,
  ProposedAccessShown,
} from "@/lib/core/proposed-access"
import { cn } from "@/lib/utils"

/** One row as the editor holds it: "" is no level, or no tier. */
export type AccessRow = {
  pattern: string
  access: ToolAccess | ""
  tier: ToolTier | ""
}

/** The rows the editor starts from: every tool, or the proposed patterns. */
export function initialAccessRows(shown: ProposedAccessShown): AccessRow[] {
  const byPattern = new Map(shown.rules.map((rule) => [rule.pattern, rule]))
  const row = (pattern: string, rule?: AccessRule): AccessRow => ({
    pattern,
    access: rule?.access ?? "",
    tier: rule?.tier ?? "",
  })

  return shown.tools
    ? shown.tools.map((tool) => row(tool.name, byPattern.get(tool.name)))
    : shown.rules.map((rule) => row(rule.pattern, rule))
}

/** What the page sends with the yes: the rows that set something. */
export function chosenAccess(rows: AccessRow[]): Array<{
  pattern: string
  access?: ToolAccess
  tier?: ToolTier
}> {
  return rows.flatMap((row) =>
    row.pattern.trim() && (row.access || row.tier)
      ? [
          {
            pattern: row.pattern.trim(),
            ...(row.access ? { access: row.access } : {}),
            ...(row.tier ? { tier: row.tier } : {}),
          },
        ]
      : [],
  )
}

/**
 * The levels and tiers an assistant proposed with a new or changed server,
 * filled in beside the approval (lib/core/proposed-access.ts). The owner
 * changes any of them; their yes saves what is left here, and nothing else.
 * Where the tools are known, each is set by name; where they are not yet
 * (an MCP server, what a service registers), by name pattern, applied once
 * to the tools PCP first reads from it.
 */
export function ProposedAccessEditor({
  shown,
  rows,
  onChange,
  disabled,
}: {
  shown: ProposedAccessShown
  rows: AccessRow[]
  onChange: (rows: AccessRow[]) => void
  disabled: boolean
}) {
  const [onlyProposed, setOnlyProposed] = useState(true)
  const proposed = new Map(shown.rules.map((rule) => [rule.pattern, rule]))
  const known = shown.tools !== null

  function update(index: number, change: Partial<AccessRow>) {
    onChange(
      rows.map((row, at) => (at === index ? { ...row, ...change } : row)),
    )
  }

  const visible = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        !known ||
        !onlyProposed ||
        proposed.has(row.pattern) ||
        row.access !== "" ||
        row.tier !== "",
    )

  return (
    <section
      aria-label="Levels and tiers"
      className="flex flex-col gap-2"
      data-testid="proposed-access"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1">
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold">Levels and tiers</h3>
          <p className="text-[13px] text-muted-foreground">
            {known
              ? `Filled in from the assistant's proposal. A level is for the token "${shown.tokenName}" only; a tier is every token's, and every server's of the same definition. Saved with your yes, as you leave them.`
              : `Its tools are not known until PCP first reads them, so these go by name: an exact tool name, or * for any run of characters (list_*). A level is for the token "${shown.tokenName}" only; a tier is every token's, and every server's of the same definition. Saved with your yes and applied once, to the tools PCP first reads from it.`}
          </p>
        </div>
        {known ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-muted-foreground">
            <Switch
              checked={onlyProposed}
              onChange={(event) => setOnlyProposed(event.target.checked)}
            />
            Only the proposed tools
          </label>
        ) : null}
      </div>
      {visible.length === 0 ? (
        <p className="px-1 text-[13px] text-muted-foreground">
          Nothing is set: its tools ask you first.
        </p>
      ) : (
        <List as="ul">
          {visible.map(({ row, index }) => {
            const asked = proposed.get(row.pattern)
            const changed =
              (asked?.access ?? "") !== row.access ||
              (asked?.tier ?? "") !== row.tier
            const label = row.pattern || "the new pattern"

            return (
              <ListRow
                as="li"
                key={known ? row.pattern : index}
                data-changed={changed ? "true" : undefined}
                className={cn(
                  row.access === "allowed" &&
                    "bg-primary/10 ring-1 ring-primary/30 ring-inset",
                )}
                title={
                  known ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="text-sm break-all">{row.pattern}</code>
                      {asked && changed ? (
                        <Badge variant="secondary">
                          Proposed:{" "}
                          {[
                            ...(asked.access
                              ? [TOOL_ACCESS_LABELS[asked.access]]
                              : []),
                            ...(asked.tier
                              ? [TOOL_TIER_LABELS[asked.tier]]
                              : []),
                          ].join(", ")}
                        </Badge>
                      ) : null}
                    </span>
                  ) : (
                    <Input
                      aria-label="Tool name or pattern"
                      value={row.pattern}
                      disabled={disabled}
                      spellCheck={false}
                      autoComplete="off"
                      className="h-8 font-mono text-[13px]"
                      onChange={(event) =>
                        update(index, { pattern: event.target.value })
                      }
                    />
                  )
                }
                description={
                  known
                    ? (shown.tools?.find((tool) => tool.name === row.pattern)
                        ?.title ?? undefined)
                    : undefined
                }
                trailing={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Select
                      aria-label={`Level of ${label}`}
                      value={row.access}
                      disabled={disabled}
                      onChange={(event) =>
                        update(index, {
                          access: event.target.value as AccessRow["access"],
                        })
                      }
                      className="h-8 w-auto text-[13px]"
                    >
                      <option value="">No level</option>
                      {TOOL_ACCESS_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {TOOL_ACCESS_LABELS[level]}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={`Tier of ${label}`}
                      value={row.tier}
                      disabled={disabled}
                      onChange={(event) =>
                        update(index, {
                          tier: event.target.value as AccessRow["tier"],
                        })
                      }
                      className="h-8 w-auto text-[13px]"
                    >
                      <option value="">Its own tier</option>
                      {TOOL_TIERS.map((tier) => (
                        <option key={tier} value={tier}>
                          {TOOL_TIER_LABELS[tier]}
                        </option>
                      ))}
                    </Select>
                    {known ? null : (
                      <Button
                        type="button"
                        variant="plain"
                        size="sm"
                        aria-label={`Remove ${label}`}
                        disabled={disabled}
                        onClick={() =>
                          onChange(rows.filter((_, at) => at !== index))
                        }
                      >
                        <X aria-hidden className="size-4" />
                      </Button>
                    )}
                  </div>
                }
              />
            )
          })}
        </List>
      )}
      {known ? null : (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() =>
              onChange([...rows, { pattern: "", access: "", tier: "" }])
            }
          >
            <Plus aria-hidden className="size-4" />
            Add a name
          </Button>
        </div>
      )}
    </section>
  )
}
