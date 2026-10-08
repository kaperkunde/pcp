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
 * right (first, on top, when they stack on a phone), and under them the
 * line saying nothing happens before the answer, with the less common
 * answers as quiet text at the right.
 *
 * `others` go left to right in the order given; the stack on a phone
 * reverses them, so the main yes sits on top and the refusal at the bottom.
 * `beside` is what goes with the main yes ("Allow for" and its time): it
 * stays next to it when the row wraps.
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
        {primary || beside ? (
          <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center">
            {beside}
            {primary}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
        {quiet && quiet.length > 0 ? (
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-1">
            {quiet}
          </div>
        ) : null}
      </div>
    </div>
  )
}
