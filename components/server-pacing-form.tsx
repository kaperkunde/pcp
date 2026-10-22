"use client"

import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { describePace, PaceFields } from "@/components/pacing-fields"
import { SubmitButton } from "@/components/submit-button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { type PacingResult, saveServerPacingAction } from "@/lib/actions/pacing"
import type { PacingOverride, PacingPolicy } from "@/lib/core/pacing/limits"

type Mode = "default" | "own" | "unpaced"

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: "default", label: "PCP's default" },
  { value: "own", label: "Your own" },
  { value: "unpaced", label: "Not paced" },
]

/**
 * A server's pace, under its Advanced: the default for its kind (Settings →
 * Pacing), one of the owner's own, or none. The browser's applies to its
 * actions on every site without a pace of its own.
 */
export function ServerPacingForm({
  serverId,
  pace,
  defaults,
  browser,
}: {
  serverId: string
  pace: PacingOverride | null
  /** What it follows without one of its own, by kind of call. */
  defaults: Array<{ label: string; pace: PacingOverride }>
  browser: boolean
}) {
  const [state, action] = useActionState<PacingResult, FormData>(
    saveServerPacingAction,
    { status: "idle" },
  )
  const [mode, setMode] = useState<Mode>(
    pace === null ? "default" : pace === "unpaced" ? "unpaced" : "own",
  )
  const start: PacingPolicy =
    pace && pace !== "unpaced"
      ? pace
      : { minIntervalMs: 1_000, jitterMs: 1_000, burst: null }

  return (
    <form action={action} className="flex flex-col gap-3" aria-label="Pacing">
      <input type="hidden" name="serverId" value={serverId} />
      <div className="flex flex-col gap-1">
        <p className="text-[15px] text-foreground">Pacing</p>
        <p className="text-xs text-muted-foreground">
          {browser
            ? "The pause between the browser's actions on a site, for every site without a pace of its own."
            : "The pause between calls to this server and how many may go in a stretch, whatever way an assistant calls."}{" "}
          Without your own:{" "}
          {defaults
            .map(
              (entry) =>
                `${entry.label} ${describePace(entry.pace).toLowerCase()}`,
            )
            .join("; ")}
          .{pace && pace !== "unpaced" ? ` Now: ${describePace(pace)}.` : ""}
        </p>
      </div>
      <SegmentedControl
        name="mode"
        legend="Pacing"
        options={MODES}
        value={mode}
        onValueChange={setMode}
      />
      {mode === "own" ? (
        <PaceFields pace={start} label="Pace this server" alwaysPaced />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
          Save pacing
        </SubmitButton>
        <FormError error={state.status === "error" ? state.error : null} />
        <FormNote message={state.status === "ok" ? state.message : null} />
      </div>
    </form>
  )
}
