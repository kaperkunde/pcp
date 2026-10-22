"use client"

import { useId, useState } from "react"

import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { PacingOverride, PacingPolicy } from "@/lib/core/pacing/limits"

function seconds(ms: number): string {
  return String(Math.round(ms) / 1000)
}

function minutes(ms: number): string {
  return String(Math.round(ms / 600) / 100)
}

/** A pace in a few words, for a row's grey line. */
export function describePace(pace: PacingOverride): string {
  if (pace === "unpaced") {
    return "Not paced"
  }

  const parts: string[] = []

  if (pace.minIntervalMs > 0 || pace.jitterMs > 0) {
    parts.push(
      pace.jitterMs > 0
        ? `${seconds(pace.minIntervalMs)} s between actions, up to ${seconds(pace.jitterMs)} s more at random`
        : `${seconds(pace.minIntervalMs)} s between actions`,
    )
  }

  if (pace.burst) {
    const per = minutes(pace.burst.perMs)
    parts.push(
      `at most ${pace.burst.max} in ${per === "1" ? "a minute" : `${per} minutes`}`,
    )
  }

  return parts.length > 0 ? parts.join(", ") : "No pause and no limit"
}

const NONE: PacingPolicy = { minIntervalMs: 0, jitterMs: 0, burst: null }

/**
 * The fields of one pace, named under `prefix` as lib/actions/pacing.ts
 * reads them: a switch for whether it is paced at all (left out with
 * `alwaysPaced`, which sends it on), the pause, the random extra wait, and
 * the cap.
 */
export function PaceFields({
  prefix = "",
  pace,
  label,
  alwaysPaced = false,
}: {
  prefix?: string
  /** What the fields start with. */
  pace: PacingOverride
  /** Names the switch: "Pace browser actions". */
  label: string
  alwaysPaced?: boolean
}) {
  const id = useId()
  const [paced, setPaced] = useState(alwaysPaced || pace !== "unpaced")
  const policy = pace === "unpaced" ? NONE : pace
  const off = !paced

  return (
    <div className="flex flex-col gap-3">
      {alwaysPaced ? (
        <input type="hidden" name={`${prefix}paced`} value="on" />
      ) : (
        <label
          htmlFor={`${id}-paced`}
          className="flex cursor-pointer items-center justify-between gap-3 text-sm"
        >
          <span>{label}</span>
          <Switch
            id={`${id}-paced`}
            name={`${prefix}paced`}
            checked={paced}
            onChange={(event) => setPaced(event.target.checked)}
          />
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Pause between actions (seconds)" htmlFor={`${id}-min`}>
          <Input
            id={`${id}-min`}
            name={`${prefix}min`}
            inputMode="decimal"
            defaultValue={seconds(policy.minIntervalMs)}
            disabled={off}
          />
        </Field>
        <Field
          label="Random extra wait, up to (seconds)"
          htmlFor={`${id}-jitter`}
          hint="A short random extra wait so it looks like a person."
        >
          <Input
            id={`${id}-jitter`}
            name={`${prefix}jitter`}
            inputMode="decimal"
            defaultValue={seconds(policy.jitterMs)}
            disabled={off}
          />
        </Field>
        <Field
          label="At most this many actions"
          htmlFor={`${id}-max`}
          hint="Empty for no limit beyond the pause."
        >
          <Input
            id={`${id}-max`}
            name={`${prefix}burstMax`}
            inputMode="numeric"
            defaultValue={policy.burst ? String(policy.burst.max) : ""}
            disabled={off}
          />
        </Field>
        <Field label="In this many minutes" htmlFor={`${id}-minutes`}>
          <Input
            id={`${id}-minutes`}
            name={`${prefix}burstMinutes`}
            inputMode="decimal"
            defaultValue={policy.burst ? minutes(policy.burst.perMs) : "1"}
            disabled={off}
          />
        </Field>
      </div>
    </div>
  )
}
