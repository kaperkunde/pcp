import type { ReactNode } from "react"

/**
 * Classes for a decision button: full width on a phone, where the buttons
 * stack, and its own width beside the others from `sm` up.
 */
export const DECISION_BUTTON = "w-full sm:w-auto"

/** A quiet decision (Block, Discard) under the buttons: small on a desktop. */
export const QUIET_DECISION = "h-11 sm:h-8"

/**
 * The foot of a request: the decision buttons, the main yes last at the
 * right (first, on top, when they stack on a phone); under them a smaller
 * choice at the left (`beside`: "Allow for" and its time) and the less
 * common answers as quiet text at the right; then the line saying nothing
 * happens before the answer.
 *
 * `others` go left to right in the order given; the stack on a phone
 * reverses them, so the main yes sits on top and the refusal at the bottom.
 * One row of at most three buttons keeps the main yes on the row it ends.
 */
export function PermissionActions({
  primary,
  beside,
  others,
  quiet,
  note,
}: {
  primary?: ReactNode
  beside?: ReactNode
  others: ReactNode[]
  quiet?: ReactNode[]
  note: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        {others}
        {primary}
      </div>
      {beside || (quiet && quiet.length > 0) ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4">
          {beside ?? <span />}
          {quiet && quiet.length > 0 ? (
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-1">
              {quiet}
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
    </div>
  )
}
