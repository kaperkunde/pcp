import type { LimitFieldShown } from "@/lib/core/gate/proposals"

/**
 * A server's limits as the owner types them (components/limits-fields.tsx):
 * each in the unit people think in (seconds for times, KiB for bytes),
 * empty for PCP's default for its kind, "none" where a limit may have no
 * cap. A field left as it was filled in keeps its value exactly, whatever
 * the unit rounds. Client components may import this: it takes types only.
 */

/** What the owner typed, by field. */
export type LimitInputs = Record<string, string>

/** A value in the field's unit, as the field shows it. */
export function shownLimit(
  field: LimitFieldShown,
  value: number | null,
): string {
  if (value === null) {
    return "none"
  }

  switch (field.unit) {
    case "ms":
      return String(value / 1000)
    case "bytes":
      return String(Math.round((value / 1024) * 1000) / 1000)
    default:
      return String(value)
  }
}

/** The unit a field is typed in, for its label. */
export function limitUnit(field: LimitFieldShown): string {
  return field.unit === "ms" ? "seconds" : field.unit === "bytes" ? "KiB" : ""
}

/** The fields filled in with what was set (or proposed). */
export function initialLimitInputs(fields: LimitFieldShown[]): LimitInputs {
  return Object.fromEntries(
    fields.map((field) => [
      field.field,
      field.value === undefined ? "" : shownLimit(field, field.value),
    ]),
  )
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
    const typed = (inputs[field.field] ?? "").trim()
    const raw = typed.toLowerCase()

    if (raw === "") {
      continue
    }

    // Untouched: the value it was filled in with, not its rounded form.
    if (field.value !== undefined && typed === shownLimit(field, field.value)) {
      limits[field.field] = field.value
      continue
    }

    if (raw === "none" && field.nullable) {
      limits[field.field] = null
      continue
    }

    if (!/^\d+(\.\d+)?$/.test(raw)) {
      const unit = limitUnit(field)
      return {
        error: `${field.label}: enter a number${unit ? ` of ${unit}` : ""}${field.nullable ? ', "none"' : ""}, or leave it empty for PCP's default.`,
      }
    }

    const value = Number(raw)
    limits[field.field] =
      field.unit === "ms"
        ? Math.round(value * 1000)
        : field.unit === "bytes"
          ? Math.round(value * 1024)
          : Math.round(value)
  }

  return { limits }
}
