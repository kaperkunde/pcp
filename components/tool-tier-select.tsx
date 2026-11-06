"use client"

import { useActionState, useRef } from "react"

import { FormError } from "@kaperkunde/ui/form-status"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { Badge } from "@kaperkunde/ui/badge"
import { Select } from "@kaperkunde/ui/input"
import type { TierActionResult } from "@/lib/actions/tool-tiers"
import {
  TOOL_TIER_HINTS,
  TOOL_TIER_LABELS,
  TOOL_TIERS,
  type ToolTier,
} from "@/lib/core/constants"
import { cn } from "@/lib/utils"

/** A tool's tier as a page shows it (lib/core/tool-tiers.ts TierInfo). */
export type ShownTier = {
  /** What applies. */
  tier: ToolTier
  /** What applies without your choice. */
  derived: ToolTier
  /** Your choice, when you made one. */
  override: ToolTier | null
  /**
   * A wrapper's tool set below what its calls came to since you chose:
   * the header's bell names it until you choose again.
   */
  below?: boolean
}

/**
 * Read, Write or Destructive for one tool, saved as soon as it is chosen:
 * "Default" goes back to what the tool says of itself (for a wrapper's
 * tool, the highest tier of the tools it calls). The hidden fields say
 * which tool; `action` saves it.
 */
export function ToolTierSelect({
  action: save,
  fields,
  tool,
  shown,
  confirmText,
  className,
}: {
  action: (
    previous: TierActionResult,
    formData: FormData,
  ) => Promise<TierActionResult>
  /** Hidden fields beside the tier: the tool, and its server. */
  fields: Record<string, string>
  /** The tool's name, for the label. */
  tool: string
  shown: ShownTier
  /** Asked before saving, when the choice reaches other servers too. */
  confirmText?: string
  className?: string
}) {
  const [state, action] = useActionState<TierActionResult, FormData>(save, {
    status: "idle",
  })
  const form = useRef<HTMLFormElement>(null)
  const value = shown.override ?? "default"

  return (
    <form
      ref={form}
      action={action}
      className={cn("flex flex-col items-end gap-1", className)}
    >
      {Object.entries(fields).map(([name, field]) => (
        <input key={name} type="hidden" name={name} value={field} />
      ))}
      <div className="flex items-center gap-2">
        {shown.override ? <Badge variant="default">set by you</Badge> : null}
        <Select
          name="tier"
          aria-label={`Tier of ${tool}`}
          title={TOOL_TIER_HINTS[shown.tier]}
          defaultValue={value}
          key={value}
          className="h-7 w-auto py-0 text-xs"
          onChange={(event) => {
            if (confirmText && !window.confirm(confirmText)) {
              event.target.value = value
              return
            }

            form.current?.requestSubmit()
          }}
        >
          <option value="default">
            Default ({TOOL_TIER_LABELS[shown.derived]})
          </option>
          {TOOL_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {TOOL_TIER_LABELS[tier]}
            </option>
          ))}
        </Select>
      </div>
      {/* Saving the same choice again records what the calls come to now. */}
      {shown.below && shown.override ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-xs text-warning">
            The tools it calls are {TOOL_TIER_LABELS[shown.derived]} now.
          </p>
          <SubmitButton size="xs" variant="secondary" pendingText="Keeping…">
            Keep {TOOL_TIER_LABELS[shown.override]}
          </SubmitButton>
        </div>
      ) : null}
      <FormError error={state.status === "error" ? state.error : null} />
    </form>
  )
}
