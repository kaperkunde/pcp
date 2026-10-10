"use client"

import { Eraser } from "lucide-react"
import Link from "next/link"
import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  cleanUpNowAction,
  type CleanupResult,
  saveCleanupAction,
} from "@/lib/actions/cleanup"
import type { CleanupOverview } from "@/lib/core/cleanup/runtime"

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Settings → Cleanup: when PCP removes what it keeps only for a while, how
 * many days of the request log it keeps, what the last run did, and
 * "Clean up now".
 */
export function CleanupCard({ overview }: { overview: CleanupOverview }) {
  const schedule =
    overview.schedules.find((option) => option.id === overview.scheduleId)
      ?.label ?? "On a schedule of your own"

  return (
    <SettingsItem
      id="cleanup"
      title="Cleanup"
      icon={Eraser}
      state={`${schedule} · the log keeps ${overview.logDays} ${
        overview.logDays === 1 ? "day" : "days"
      }`}
      about={
        <>
          PCP removes what it keeps only for a while: sign-ins that ended (yours
          and apps&apos;), results kept for a day, permission requests a week
          after they expired, and days of the{" "}
          <Link
            href="/log"
            className="text-primary underline-offset-4 hover:underline"
          >
            log
          </Link>{" "}
          older than you keep. It does this when it starts and then on the
          schedule below.
        </>
      }
    >
      <CleanupStatusLine overview={overview} />
      <CleanNowButton />
      <CleanupForm overview={overview} />
    </SettingsItem>
  )
}

function CleanupStatusLine({ overview }: { overview: CleanupOverview }) {
  const { status, lastRemoved, nextRunAt, log } = overview

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="cleanup-status">
      <div className="flex flex-wrap items-center gap-2">
        {status.problems?.length ? (
          <Badge variant="warning">Last cleanup had problems</Badge>
        ) : status.lastRunAt ? (
          <Badge>Healthy</Badge>
        ) : (
          <Badge variant="outline">Not run yet</Badge>
        )}
        {status.lastRunAt ? (
          <span>
            Last ran <LocalDate value={status.lastRunAt} />
            {status.trigger === "owner"
              ? " because you asked"
              : status.trigger === "start"
                ? " when PCP started"
                : ""}
            : {lastRemoved ? `removed ${lastRemoved}` : "nothing to remove"}
            {status.freedBytes
              ? `, and gave ${size(status.freedBytes)} of disk back`
              : ""}
            .
          </span>
        ) : null}
      </div>
      {status.problems?.map((problem) => (
        <p key={problem} className="text-warning">
          {problem} The server log says why; the next cleanup tries again.
        </p>
      ))}
      {nextRunAt ? (
        <p className="text-muted-foreground">
          Next cleanup <LocalDate value={nextRunAt} />.
        </p>
      ) : null}
      <p className="text-muted-foreground">
        {log.days === 0
          ? "The log is empty."
          : `The log holds ${log.days} ${log.days === 1 ? "day" : "days"} (${size(log.bytes)})${log.oldest ? `, the oldest ${log.oldest}` : ""}.`}
      </p>
    </div>
  )
}

function CleanNowButton() {
  const [state, action] = useActionState<CleanupResult>(cleanUpNowAction, {
    status: "idle",
  })

  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      aria-label="Clean up now"
    >
      <SubmitButton variant="secondary" pendingText="Cleaning up…">
        Clean up now
      </SubmitButton>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}

function CleanupForm({ overview }: { overview: CleanupOverview }) {
  const [state, action] = useActionState<CleanupResult, FormData>(
    saveCleanupAction,
    { status: "idle" },
  )
  const [schedule, setSchedule] = useState(overview.scheduleId)

  return (
    <form
      action={action}
      className="flex flex-col gap-4"
      aria-label="Cleanup schedule"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="When"
          htmlFor="cleanup-schedule"
          hint={`In this machine's time zone, ${overview.timeZone}.`}
        >
          <Select
            id="cleanup-schedule"
            name="schedule"
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
          >
            {overview.schedules.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            <option value="custom">Custom schedule</option>
          </Select>
        </Field>
        <Field
          label="Keep the log for"
          htmlFor="cleanup-log-days"
          hint="Days, today included. Older days are deleted at the next cleanup."
        >
          <Input
            id="cleanup-log-days"
            name="logDays"
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            defaultValue={overview.logDays}
            required
          />
        </Field>
      </div>
      {schedule === "custom" ? (
        <Field
          label="Custom schedule"
          htmlFor="cleanup-cron"
          hint="Five cron fields: minute, hour, day of month, month and day of week, as in 30 */2 * * * for half past every second hour. It has to run at least once a day."
        >
          <Input
            id="cleanup-cron"
            name="cron"
            defaultValue={overview.cron}
            placeholder="7 * * * *"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            required
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" pendingText="Saving…">
          Save
        </SubmitButton>
        <FormError error={state.status === "error" ? state.error : null} />
        <FormNote message={state.status === "ok" ? state.message : null} />
      </div>
    </form>
  )
}
