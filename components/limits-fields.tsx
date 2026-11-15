"use client"

import { useId } from "react"

import { Input } from "@kaperkunde/ui/input"
import { Field } from "@kaperkunde/ui/label"
import type { LimitFieldShown } from "@/lib/core/gate/proposals"

/**
 * A server's limits as fields (lib/core/gate/): each in the unit people
 * think in (seconds for times, MiB for bytes), empty for PCP's default for
 * its kind, "none" where a limit may have no cap. Used beside an approval
 * (register_server's limits, a limits_change) and in the Limits section of
 * a server's page; what it sends is checked again in core.
 */

/** What the owner typed, by field. */
export type LimitInputs = Record<string, string>

function shownValue(field: LimitFieldShown, value: number | null): string {
  if (value === null) {
    return "none"
  }

  switch (field.unit) {
    case "ms":
      return String(Math.round(value) / 1000)
    case "bytes":
      return String(Math.round((value / 1024 ** 2) * 100) / 100)
    default:
      return String(value)
  }
}

/** The fields filled in with what was set (or proposed). */
export function initialLimitInputs(fields: LimitFieldShown[]): LimitInputs {
  return Object.fromEntries(
    fields.map((field) => [
      field.field,
      field.value === undefined ? "" : shownValue(field, field.value),
    ]),
  )
}

function unitWord(field: LimitFieldShown): string {
  return field.unit === "ms" ? "seconds" : field.unit === "bytes" ? "MiB" : ""
}

/**
 * The limits as core takes them: a number per field set, null for none;
 * empty fields left out (PCP's default). A field that is no number is
 * named in the error.
 */
export function limitsFromInputs(
  fields: LimitFieldShown[],
  inputs: LimitInputs,
): { limits: Record<string, number | null> } | { error: string } {
  const limits: Record<string, number | null> = {}

  for (const field of fields) {
    const raw = (inputs[field.field] ?? "").trim().toLowerCase()

    if (raw === "") {
      continue
    }

    if (raw === "none" && field.nullable) {
      limits[field.field] = null
      continue
    }

    if (!/^\d+(\.\d+)?$/.test(raw)) {
      return {
        error: `${field.label}: enter a number${unitWord(field) ? ` of ${unitWord(field)}` : ""}${field.nullable ? ', "none"' : ""}, or leave it empty for PCP's default.`,
      }
    }

    const value = Number(raw)
    limits[field.field] =
      field.unit === "ms"
        ? Math.round(value * 1000)
        : field.unit === "bytes"
          ? Math.round(value * 1024 ** 2)
          : Math.round(value)
  }

  return { limits }
}

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
        const unit = unitWord(field)

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
                  : shownValue(field, field.defaultValue)
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
