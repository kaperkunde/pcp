"use client"

import { useId } from "react"

import { Input } from "@kaperkunde/ui/input"
import { Field } from "@kaperkunde/ui/label"
import type { LimitFieldShown } from "@/lib/core/gate/proposals"
import { limitUnit, shownLimit, type LimitInputs } from "@/lib/limit-inputs"

export {
  initialLimitInputs,
  limitsFromInputs,
  type LimitInputs,
} from "@/lib/limit-inputs"

/**
 * A server's limits as fields (lib/core/gate/): each in the unit people
 * think in (seconds for times, KiB for bytes), empty for PCP's default for
 * its kind, "none" where a limit may have no cap. Used beside an approval
 * (register_server's limits, a limits_change) and in the Limits section of
 * a server's page; what it sends is checked again in core.
 */

export function LimitsFields({
  fields,
  inputs,
  onChange,
  disabled = false,
}: {
  fields: LimitFieldShown[]
  inputs: LimitInputs
  onChange: (next: LimitInputs) => void
  disabled?: boolean
}) {
  const id = useId()

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const unit = limitUnit(field)

        return (
          <Field
            key={field.field}
            label={unit ? `${field.label} (${unit})` : field.label}
            htmlFor={`${id}-${field.field}`}
            hint={`Empty: PCP's default, ${field.defaultShown}.${field.nullable ? ' "none" for no cap.' : ""}`}
          >
            <Input
              id={`${id}-${field.field}`}
              inputMode="decimal"
              value={inputs[field.field] ?? ""}
              placeholder={
                field.defaultValue === null
                  ? "none"
                  : shownLimit(field, field.defaultValue)
              }
              onChange={(event) =>
                onChange({ ...inputs, [field.field]: event.target.value })
              }
              disabled={disabled}
            />
          </Field>
        )
      })}
    </div>
  )
}
