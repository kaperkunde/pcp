"use client"

import { Checkbox } from "@/components/ui/input"

/**
 * The "All tokens" box beside one of a token's levels (a tool, a web fetch
 * method or site). Ticked, the level is the one every token follows unless
 * it has its own. Unticked while all tokens have a level, this token's own
 * line is what hides it, and the hint says what the others get.
 */
export function AllTokensCheckbox({
  checked,
  disabled,
  label,
  sharedLevel,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  /** What it is for, read out by a screen reader: "All tokens for GET". */
  label: string
  /** The level all tokens have, shown while this token overrides it. */
  sharedLevel: string | null
  onChange: (checked: boolean) => void
}) {
  return (
    <span className="flex items-center gap-2">
      <label
        className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
        title="The level for every token; a token's own level still wins."
      >
        <Checkbox
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        All tokens
      </label>
      {!checked && sharedLevel ? (
        <span className="text-xs text-muted-foreground">
          (all tokens: {sharedLevel})
        </span>
      ) : null}
    </span>
  )
}
