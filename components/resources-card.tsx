"use client"

import { Gauge } from "lucide-react"
import { useActionState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@/components/submit-button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  type ResourcesResult,
  saveResourcesAction,
} from "@/lib/actions/resources"
import type {
  ResourceField,
  ResourcesOverview,
} from "@/lib/core/resources/state"

function size(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  return gb >= 1
    ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
    : `${Math.round(bytes / (1024 * 1024))} MB`
}

function megabytes(mb: number): string {
  return mb >= 1024 ? size(mb * 1024 * 1024) : `${mb} MB`
}

const ROWS: Array<{
  field: ResourceField
  label: string
  unit: "MB" | ""
  hint: string
}> = [
  {
    field: "programMemoryMb",
    label: "A program's memory (MB)",
    unit: "MB",
    hint: "What one program an assistant runs with run_code may hold.",
  },
  {
    field: "programsAtOnce",
    label: "Programs at once",
    unit: "",
    hint: "For every token together; one more waits for its turn.",
  },
  {
    field: "fileMb",
    label: "Largest file (MB)",
    unit: "MB",
    hint: "The largest file PCP keeps for an assistant (an attachment, a download), and so what a program reads of one.",
  },
  {
    field: "keptMb",
    label: "Kept results per token (MB)",
    unit: "MB",
    hint: "Results go a day after they were made; past this, the oldest go first.",
  },
]

/**
 * Settings → Resources: how much of this machine PCP may use for what
 * assistants hand it. Each is PCP's pick for the machine unless you set it.
 */
export function ResourcesCard({ overview }: { overview: ResourcesOverview }) {
  const [state, action] = useActionState<ResourcesResult, FormData>(
    saveResourcesAction,
    { status: "idle" },
  )
  const { machine } = overview

  const custom = ROWS.some((row) => overview.config[row.field] != null)

  return (
    <SettingsItem
      id="resources"
      title="Resources"
      icon={Gauge}
      state={custom ? "Limits you set" : "PCP's pick for this machine"}
      about={
        <>
          How much of this machine PCP may use for what assistants hand it. Left
          empty, PCP picks from what the machine has:{" "}
          {size(machine.memoryBytes)} of memory, {machine.processors}{" "}
          {machine.processors === 1 ? "processor" : "processors"}
          {machine.disk
            ? `, and ${size(machine.disk.freeBytes)} free where it keeps its data`
            : ""}
          .
        </>
      }
    >
      <form
        action={action}
        className="flex flex-col gap-4"
        aria-label="Resources"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {ROWS.map((row) => {
            const id = `resources-${row.field}`
            const automatic = overview.automatic[row.field]

            return (
              <Field
                key={row.field}
                label={row.label}
                htmlFor={id}
                hint={`${row.hint} Empty for PCP's pick: ${row.unit ? megabytes(automatic) : automatic}.`}
              >
                <Input
                  id={id}
                  name={row.field}
                  type="number"
                  inputMode="numeric"
                  min={overview.bounds[row.field].min}
                  max={overview.bounds[row.field].max}
                  defaultValue={overview.config[row.field] ?? ""}
                  placeholder={String(automatic)}
                />
              </Field>
            )
          })}
        </div>
        <p className="text-sm text-muted-foreground">
          In use: {overview.chosen.programsAtOnce}{" "}
          {overview.chosen.programsAtOnce === 1 ? "program" : "programs"} of{" "}
          {megabytes(overview.chosen.programMemoryMb)} at once, files up to{" "}
          {megabytes(overview.chosen.fileMb)}, and{" "}
          {megabytes(overview.chosen.keptMb)} of kept results per token.
          Programs together may hold at most{" "}
          {megabytes(overview.maxProgramsMemoryMb)}, three quarters of this
          machine&apos;s memory.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton variant="secondary" pendingText="Saving…">
            Save
          </SubmitButton>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
        </div>
      </form>
    </SettingsItem>
  )
}
