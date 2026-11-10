"use client"

import { Repeat } from "lucide-react"
import { useActionState, useState } from "react"

import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { Input, Select } from "@kaperkunde/ui/input"
import { Field } from "@kaperkunde/ui/label"
import { SegmentedControl } from "@kaperkunde/ui/segmented-control"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { SettingsItem } from "@/components/settings-item"
import {
  type RepeatedCallsResult,
  removeRepeatedCallsToolAction,
  saveRepeatedCallsDefaultAction,
  saveRepeatedCallsToolAction,
} from "@/lib/actions/repeated-calls"
import type {
  DuplicateCallsOverview,
  GuardOverride,
} from "@/lib/core/calls/config"

const IDLE: RepeatedCallsResult = { status: "idle" }

function Status({ state }: { state: RepeatedCallsResult }) {
  return (
    <>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </>
  )
}

function minutesText(minutes: number): string {
  return minutes % 60 === 0 && minutes >= 120
    ? `${minutes / 60} hours`
    : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
}

function valueText(value: GuardOverride): string {
  return value === "exempt" ? "never held back" : minutesText(value)
}

/**
 * Settings → Repeated calls: how long PCP holds back the same Write or
 * Destructive call an assistant makes again, for every tool, and a time of
 * its own (or none) for a tool. Set once and rarely looked at again.
 */
export function RepeatedCallsCard({
  overview,
}: {
  overview: DuplicateCallsOverview
}) {
  const own = overview.tools.length

  return (
    <SettingsItem
      id="repeated-calls"
      title="Repeated calls"
      icon={Repeat}
      state={[
        overview.ownDefault
          ? `${minutesText(overview.defaultMinutes)}, your own`
          : `${minutesText(overview.defaultMinutes)}, PCP's default`,
        own > 0 ? `${own} ${own === 1 ? "tool" : "tools"} of your own` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      about={
        <>
          An assistant sometimes makes a call that changes things twice: it lost
          the answer, or tried again to be safe. When it makes the same call
          (the same tool with the same arguments) again within this time, PCP
          does not run it but tells the assistant how the first one went; it
          runs it again only when the assistant says it means to, with a reason.
          Tools that only read, the browser, SSH commands and stores are never
          held back.
        </>
      }
    >
      <DefaultForm
        key={`${overview.defaultMinutes}-${overview.ownDefault}`}
        overview={overview}
      />
      {overview.tools.map((entry) => (
        <ToolRow key={entry.key} entry={entry} />
      ))}
      <ToolForm key={`new-${own}`} overview={overview} />
    </SettingsItem>
  )
}

function DefaultForm({ overview }: { overview: DuplicateCallsOverview }) {
  const [state, action] = useActionState(saveRepeatedCallsDefaultAction, IDLE)

  return (
    <form
      action={action}
      className="flex flex-col gap-3"
      aria-label="Repeated calls for every tool"
    >
      <Field
        label="Hold back a repeat for"
        htmlFor="repeated-calls-minutes"
        hint={`Minutes, ${overview.bounds.min} to ${overview.bounds.max.toLocaleString("en")}. Empty is PCP's default, ${overview.pcpDefaultMinutes}.`}
      >
        <Input
          id="repeated-calls-minutes"
          name="minutes"
          inputMode="numeric"
          defaultValue={overview.ownDefault ? overview.defaultMinutes : ""}
          placeholder={String(overview.pcpDefaultMinutes)}
          autoComplete="off"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" pendingText="Saving…">
          Save
        </SubmitButton>
        <Status state={state} />
      </div>
    </form>
  )
}

/** A tool with a time of its own, and the button that takes it away. */
function ToolRow({
  entry,
}: {
  entry: DuplicateCallsOverview["tools"][number]
}) {
  const [state, action] = useActionState(removeRepeatedCallsToolAction, IDLE)

  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2 rounded-lg bg-field/40 p-3"
    >
      <input type="hidden" name="tool" value={entry.key} />
      <p className="min-w-0 flex-1 text-sm">
        <span className="text-foreground">
          {entry.server} / {entry.tool}
        </span>{" "}
        <span className="text-muted-foreground">{valueText(entry.value)}</span>
      </p>
      <SubmitButton variant="plain" size="sm" pendingText="Removing…">
        Use the default
      </SubmitButton>
      <Status state={state} />
    </form>
  )
}

/** Gives a tool a time of its own, or has it never held back. */
function ToolForm({ overview }: { overview: DuplicateCallsOverview }) {
  const [state, action] = useActionState(saveRepeatedCallsToolAction, IDLE)
  const [mode, setMode] = useState<"minutes" | "never">("minutes")

  if (overview.choices.length === 0) {
    return null
  }

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg bg-field/40 p-3"
      aria-label="A time of its own for a tool"
    >
      <p className="text-[15px] text-foreground">A tool of its own</p>
      <Field label="Tool" htmlFor="repeated-calls-tool">
        <Select id="repeated-calls-tool" name="tool" defaultValue="">
          <option value="" disabled>
            Choose a tool
          </option>
          {overview.choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.server} / {choice.tool}
            </option>
          ))}
        </Select>
      </Field>
      <SegmentedControl
        name="mode"
        legend="How long to hold back a repeat of this tool"
        size="sm"
        options={[
          { value: "minutes", label: "A time of its own" },
          { value: "never", label: "Never hold back" },
        ]}
        value={mode}
        onValueChange={setMode}
      />
      {mode === "minutes" ? (
        <Field
          label="Minutes"
          htmlFor="repeated-calls-tool-minutes"
          hint={`${overview.bounds.min} to ${overview.bounds.max.toLocaleString("en")}.`}
        >
          <Input
            id="repeated-calls-tool-minutes"
            name="minutes"
            inputMode="numeric"
            defaultValue={overview.defaultMinutes}
            autoComplete="off"
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
          Save
        </SubmitButton>
        <Status state={state} />
      </div>
    </form>
  )
}
