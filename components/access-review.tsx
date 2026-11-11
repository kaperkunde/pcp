"use client"

import { useMemo, useState } from "react"

import { useAnswer } from "@/components/answer-queue"
import { FormError } from "@kaperkunde/ui/form-status"
import {
  DECISION_BUTTON,
  PermissionActions,
  QUIET_DECISION,
} from "@/components/permission-actions"
import { PermissionOutcome } from "@/components/permission-outcome"
import { Badge } from "@kaperkunde/ui/badge"
import { Button } from "@kaperkunde/ui/button"
import { Select } from "@kaperkunde/ui/input"
import { List, ListRow } from "@kaperkunde/ui/list"
import {
  SegmentedControl,
  type SegmentedOption,
} from "@kaperkunde/ui/segmented-control"
import { Switch } from "@kaperkunde/ui/switch"
import {
  decidePermissionAction,
  saveAccessRequestAction,
} from "@/lib/actions/permissions"
import type {
  AccessLevel,
  AccessTier,
  ShownTierNow,
  TierChoice,
} from "@/lib/core/access-requests"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  TOOL_TIER_LABELS,
  TOOL_TIERS,
  type ToolAccess,
} from "@/lib/core/constants"
import type { TokenServerAccess } from "@/lib/core/tool-access"
import { cn } from "@/lib/utils"

function keyOf(serverId: string, tool: string): string {
  return `${serverId}/${tool}`
}

/** PCP's own tools are keyed as the server "pcp". */
function tierKeyOf(serverId: string | null, tool: string): string {
  return keyOf(serverId ?? "pcp", tool)
}

function tierLabel(choice: TierChoice, shown?: ShownTierNow): string {
  return choice === "default"
    ? `Default (${shown ? TOOL_TIER_LABELS[shown.derived] : "its own"})`
    : TOOL_TIER_LABELS[choice]
}

function summary(levels: ToolAccess[]): string {
  return TOOL_ACCESS_LEVELS.flatMap((access) => {
    const count = levels.filter((level) => level === access).length
    return count > 0 ? [`${count} to ${TOOL_ACCESS_LABELS[access]}`] : []
  }).join(", ")
}

/**
 * The levels an assistant proposed for its token, filled in over what the
 * token has now. Every tool whose level would change is marked; the owner
 * can change any of them, and nothing is written until they save.
 */
export function AccessReview({
  id,
  servers,
  proposed,
  tiers = {},
  proposedTiers = [],
  ownTools = [],
  sharedWith = {},
}: {
  id: string
  servers: TokenServerAccess[]
  proposed: AccessLevel[]
  /** Each tool's tier now, by serverId/tool. */
  tiers?: Record<string, ShownTierNow>
  /** The tiers the assistant proposed. */
  proposedTiers?: AccessTier[]
  /** PCP's own tools whose tier was proposed, with theirs now. */
  ownTools?: Array<{ name: string; title: string } & ShownTierNow>
  /** Per server: the other servers a tier there reaches too. */
  sharedWith?: Record<string, string[]>
}) {
  const initial = useMemo(
    () =>
      Object.fromEntries(
        proposed.map((level) => [
          keyOf(level.serverId, level.tool),
          level.access,
        ]),
      ) as Record<string, ToolAccess>,
    [proposed],
  )
  const [chosen, setChosen] = useState<Record<string, ToolAccess>>(initial)
  const initialTiers = useMemo(
    () =>
      Object.fromEntries(
        proposedTiers.map((entry) => [
          tierKeyOf(entry.serverId, entry.tool),
          entry.tier,
        ]),
      ) as Record<string, TierChoice>,
    [proposedTiers],
  )
  const [chosenTiers, setChosenTiers] =
    useState<Record<string, TierChoice>>(initialTiers)
  /** A tool's tier choice as it stands: the owner's, or "default". */
  const tierNow = (key: string): TierChoice => {
    const shown =
      tiers[key] ?? ownTools.find((tool) => `pcp/${tool.name}` === key)
    return shown?.override ?? "default"
  }
  const [onlyChanges, setOnlyChanges] = useState(true)
  // The same way through as every other answer: the count drops at once,
  // then the owner is taken on to the next request.
  const { submit, pending, error, done } = useAnswer({ request: id })

  const changes = servers.flatMap((server) =>
    server.tools.flatMap((tool) => {
      const access = chosen[keyOf(server.id, tool.name)] ?? tool.access
      return access !== tool.access
        ? [{ serverId: server.id, tool: tool.name, access }]
        : []
    }),
  )
  const tierChanges = [
    ...servers.flatMap((server) =>
      server.tools.flatMap((tool) => {
        const key = keyOf(server.id, tool.name)
        const tier = chosenTiers[key] ?? tierNow(key)
        return tier !== tierNow(key)
          ? [{ serverId: server.id, tool: tool.name, tier }]
          : []
      }),
    ),
    ...ownTools.flatMap((tool) => {
      const key = tierKeyOf(null, tool.name)
      const tier = chosenTiers[key] ?? tierNow(key)
      return tier !== tierNow(key)
        ? [{ serverId: null, tool: tool.name, tier }]
        : []
    }),
  ]
  const edited =
    Object.entries(chosen).some(([key, access]) => initial[key] !== access) ||
    Object.entries(chosenTiers).some(
      ([key, tier]) => initialTiers[key] !== tier,
    )

  function setTier(key: string, tier: TierChoice) {
    setChosenTiers((previous) => ({ ...previous, [key]: tier }))
  }

  function set(keys: string[], access: ToolAccess) {
    setChosen((previous) => ({
      ...previous,
      ...Object.fromEntries(keys.map((key) => [key, access])),
    }))
  }

  function save() {
    submit(async () => {
      const result = await saveAccessRequestAction(id, changes, tierChanges)

      return result.status === "ok"
        ? {
            ...result,
            // The outcome's text is written for the assistant. The page
            // re-renders as answered and says the same.
            message: result.isError
              ? result.message
              : "You saved these levels and tiers.",
          }
        : { error: result.status === "error" ? result.error : "Not sent." }
    })
  }

  function decline() {
    submit(async () => {
      const result = await decidePermissionAction(id, "decline")

      return result.status === "ok"
        ? {
            ...result,
            message: result.isError
              ? result.message
              : "You said no, so no tool's level changed.",
          }
        : { error: result.status === "error" ? result.error : "Not sent." }
    })
  }

  if (done) {
    return (
      <PermissionOutcome
        outcome={done.message}
        outcomeIsError={done.isError}
        tone={done.isError ? "error" : "ok"}
      />
    )
  }

  const shown = servers
    .map((server) => ({
      server,
      tools: server.tools.filter((tool) => {
        const key = keyOf(server.id, tool.name)
        return (
          !onlyChanges ||
          key in initial ||
          key in initialTiers ||
          (chosen[key] ?? tool.access) !== tool.access ||
          (chosenTiers[key] ?? tierNow(key)) !== tierNow(key)
        )
      }),
    }))
    .filter((entry) => entry.tools.length > 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p role="status" data-testid="access-summary" className="font-medium">
          {changes.length === 0 && tierChanges.length === 0
            ? "Saving now changes nothing."
            : [
                ...(changes.length > 0
                  ? [
                      `Saving changes ${changes.length} tool${changes.length === 1 ? "" : "s"}: ${summary(changes.map((change) => change.access))}.`,
                    ]
                  : []),
                ...(tierChanges.length > 0
                  ? [
                      `${tierChanges.length} tool${tierChanges.length === 1 ? " gets" : "s get"} another tier.`,
                    ]
                  : []),
              ].join(" ")}
        </p>
        <label className="flex cursor-pointer items-center gap-2.5 text-muted-foreground">
          <Switch
            checked={onlyChanges}
            onChange={(event) => setOnlyChanges(event.target.checked)}
          />
          Only the proposed tools
        </label>
      </div>
      {shown.length === 0 && ownTools.length === 0 ? (
        <p className="text-muted-foreground">
          None of the proposed tools are left on this token.
        </p>
      ) : (
        shown.map(({ server, tools }) => (
          <ServerLevels
            key={server.id}
            server={server}
            tools={tools}
            chosen={chosen}
            proposed={initial}
            tiers={tiers}
            chosenTiers={chosenTiers}
            proposedTiers={initialTiers}
            sharedWith={sharedWith[server.id] ?? []}
            disabled={pending}
            onChange={set}
            onTierChange={setTier}
          />
        ))
      )}
      {ownTools.length > 0 ? (
        <OwnTiers
          tools={ownTools}
          chosenTiers={chosenTiers}
          proposedTiers={initialTiers}
          disabled={pending}
          onTierChange={setTier}
        />
      ) : null}
      <FormError error={error} />
      <PermissionActions
        note="Nothing changes until you save. Then tell the assistant you have."
        others={[
          <Button
            key="decline"
            type="button"
            size="lg"
            variant="secondary"
            className={DECISION_BUTTON}
            disabled={pending}
            onClick={decline}
          >
            Not now
          </Button>,
        ]}
        primary={
          <Button
            type="button"
            size="lg"
            className={DECISION_BUTTON}
            disabled={pending}
            onClick={save}
          >
            {pending ? "Working…" : "Save changes"}
          </Button>
        }
        quiet={
          edited
            ? [
                <Button
                  key="reset"
                  type="button"
                  variant="plain"
                  className={QUIET_DECISION}
                  disabled={pending}
                  onClick={() => {
                    setChosen(initial)
                    setChosenTiers(initialTiers)
                  }}
                >
                  Back to the proposal
                </Button>,
              ]
            : []
        }
      />
    </div>
  )
}

function ServerLevels({
  server,
  tools,
  chosen,
  proposed,
  tiers,
  chosenTiers,
  proposedTiers,
  sharedWith,
  disabled,
  onChange,
  onTierChange,
}: {
  server: TokenServerAccess
  tools: TokenServerAccess["tools"]
  chosen: Record<string, ToolAccess>
  proposed: Record<string, ToolAccess>
  tiers: Record<string, ShownTierNow>
  chosenTiers: Record<string, TierChoice>
  proposedTiers: Record<string, TierChoice>
  /** The other servers a tier here reaches too. */
  sharedWith: string[]
  disabled: boolean
  onChange: (keys: string[], access: ToolAccess) => void
  onTierChange: (key: string, tier: TierChoice) => void
}) {
  const tierChanged = (key: string) =>
    (chosenTiers[key] ?? tiers[key]?.override ?? "default") !==
    (tiers[key]?.override ?? "default")
  const anyTier = tools.some((tool) => tierChanged(keyOf(server.id, tool.name)))
  const [bulk, setBulk] = useState<ToolAccess>("ask")

  return (
    <section aria-label={server.name} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15px] font-semibold">{server.name}</h3>
          <code className="text-xs text-muted-foreground">{server.slug}</code>
          {server.enabled ? null : (
            <Badge variant="secondary">Switched off</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            aria-label={`All shown tools on ${server.slug}`}
            value={bulk}
            onChange={(event) => setBulk(event.target.value as ToolAccess)}
            className="h-8 w-auto text-[13px]"
          >
            <AccessOptions />
          </Select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() =>
              onChange(
                tools.map((tool) => keyOf(server.id, tool.name)),
                bulk,
              )
            }
            aria-label={`Set all shown tools on ${server.slug}`}
          >
            Set all shown
          </Button>
        </div>
      </div>
      {anyTier && sharedWith.length > 0 ? (
        <p className="px-1 text-[13px] text-warning">
          A tier here is also the tier on {sharedWith.join(", ")}: they share a
          definition with {server.name}.
        </p>
      ) : null}
      <List as="ul">
        {tools.map((tool) => {
          const key = keyOf(server.id, tool.name)
          const value = chosen[key] ?? tool.access
          const shownTier = tiers[key]
          const tierValue = chosenTiers[key] ?? shownTier?.override ?? "default"
          const tierMoved = tierChanged(key)
          const changed = value !== tool.access || tierMoved
          const asked = proposed[key]
          const askedTier = proposedTiers[key]

          return (
            <ListRow
              as="li"
              key={tool.name}
              data-changed={changed ? "true" : undefined}
              className={cn(
                changed && "bg-primary/10 ring-1 ring-primary/30 ring-inset",
              )}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <code className="text-sm break-all">{tool.name}</code>
                  {changed ? (
                    <Badge variant="warning">
                      Now: {TOOL_ACCESS_LABELS[tool.access]}
                    </Badge>
                  ) : null}
                  {asked && asked !== value ? (
                    <Badge variant="secondary">
                      Proposed: {TOOL_ACCESS_LABELS[asked]}
                    </Badge>
                  ) : null}
                  {tierMoved && shownTier ? (
                    <Badge variant="warning">
                      Tier now: {TOOL_TIER_LABELS[shownTier.tier]}
                    </Badge>
                  ) : null}
                  {askedTier && askedTier !== tierValue ? (
                    <Badge variant="secondary">
                      Proposed tier: {tierLabel(askedTier, shownTier)}
                    </Badge>
                  ) : null}
                </span>
              }
              description={tool.title || undefined}
              trailing={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <SegmentedControl
                    name={`level-${key}`}
                    legend={`Access to ${server.slug}/${tool.name}`}
                    size="sm"
                    options={LEVEL_OPTIONS}
                    value={value}
                    disabled={disabled}
                    onValueChange={(access) => onChange([key], access)}
                  />
                  <TierSelect
                    label={`Tier of ${server.slug}/${tool.name}`}
                    value={tierValue}
                    shown={shownTier}
                    disabled={disabled}
                    onChange={(tier) => onTierChange(key, tier)}
                  />
                </div>
              }
            />
          )
        })}
      </List>
    </section>
  )
}

const LEVEL_OPTIONS: SegmentedOption<ToolAccess>[] = TOOL_ACCESS_LEVELS.map(
  (level) => ({
    value: level,
    label: TOOL_ACCESS_LABELS[level],
    tone:
      level === "allowed" ? "allow" : level === "blocked" ? "block" : undefined,
  }),
)

function AccessOptions() {
  return TOOL_ACCESS_LEVELS.map((level) => (
    <option key={level} value={level}>
      {TOOL_ACCESS_LABELS[level]}
    </option>
  ))
}

/** Read, Write, Destructive or the tool's own, for one tool. */
function TierSelect({
  label,
  value,
  shown,
  disabled,
  onChange,
}: {
  label: string
  value: TierChoice
  shown: ShownTierNow | undefined
  disabled: boolean
  onChange: (tier: TierChoice) => void
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as TierChoice)}
      className="h-8 w-auto text-[13px]"
    >
      <option value="default">{tierLabel("default", shown)}</option>
      {TOOL_TIERS.map((tier) => (
        <option key={tier} value={tier}>
          {TOOL_TIER_LABELS[tier]}
        </option>
      ))}
    </Select>
  )
}

/** PCP's own tools whose tier was proposed: a tier each, no level. */
function OwnTiers({
  tools,
  chosenTiers,
  proposedTiers,
  disabled,
  onTierChange,
}: {
  tools: Array<{ name: string; title: string } & ShownTierNow>
  chosenTiers: Record<string, TierChoice>
  proposedTiers: Record<string, TierChoice>
  disabled: boolean
  onTierChange: (key: string, tier: TierChoice) => void
}) {
  return (
    <section aria-label="PCP's own tools" className="flex flex-col gap-2">
      <div className="flex flex-col gap-1 px-1">
        <h3 className="text-[15px] font-semibold">PCP&apos;s own tools</h3>
        <p className="text-[13px] text-muted-foreground">
          What PCP tells every assistant&apos;s app each one can do. Settings
          has them all.
        </p>
      </div>
      <List as="ul">
        {tools.map((tool) => {
          const key = tierKeyOf(null, tool.name)
          const value = chosenTiers[key] ?? tool.override ?? "default"
          const changed = value !== (tool.override ?? "default")
          const asked = proposedTiers[key]

          return (
            <ListRow
              as="li"
              key={tool.name}
              data-changed={changed ? "true" : undefined}
              className={cn(
                changed && "bg-primary/10 ring-1 ring-primary/30 ring-inset",
              )}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <code className="text-sm break-all">{tool.name}</code>
                  {changed ? (
                    <Badge variant="warning">
                      Tier now: {TOOL_TIER_LABELS[tool.tier]}
                    </Badge>
                  ) : null}
                  {asked && asked !== value ? (
                    <Badge variant="secondary">
                      Proposed tier: {tierLabel(asked, tool)}
                    </Badge>
                  ) : null}
                </span>
              }
              description={tool.title}
              trailing={
                <TierSelect
                  label={`Tier of ${tool.name}`}
                  value={value}
                  shown={tool}
                  disabled={disabled}
                  onChange={(tier) => onTierChange(key, tier)}
                />
              }
            />
          )
        })}
      </List>
    </section>
  )
}
