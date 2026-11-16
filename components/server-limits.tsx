"use client"

import { useActionState, useState, useTransition, type ReactNode } from "react"

import { Button } from "@kaperkunde/ui/button"
import { Disclosure } from "@kaperkunde/ui/disclosure"
import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { List, ListRow, ListSection, RowValue } from "@kaperkunde/ui/list"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import {
  initialLimitInputs,
  LimitsFields,
  limitsFromInputs,
  type LimitInputs,
} from "@/components/limits-fields"
import { LocalDate } from "@/components/local-date"
import {
  endCoolingAction,
  saveServerLimitsAction,
  type LimitsResult,
} from "@/lib/actions/limits"
import type { ServerLimitsView } from "@/lib/core/gate/proposals"
import type { MailDiagnostic, MailPhase } from "@/lib/core/mail/diagnostics"
import { shownLimit } from "@/lib/limit-inputs"

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}

function ms(value: number | null): string {
  if (value === null) return "–"
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`
}

const OUTCOME_WORDS: Record<MailDiagnostic["outcome"], string> = {
  ok: "went through",
  error: "failed",
  throttled: "the server asked PCP to slow down",
}

const PHASE_WORDS: Record<MailPhase, string> = {
  connect: "connecting",
  login: "signing in",
  select: "opening the mailbox",
  command: "the command",
  logout: "logging out",
}

/** A call's phases in order, each with its time. */
function phasesLine(phases: MailDiagnostic["phases"]): string {
  const said = (Object.keys(PHASE_WORDS) as MailPhase[])
    .filter((phase) => phases[phase] !== undefined)
    .map((phase) => `${PHASE_WORDS[phase]} ${ms(phases[phase]!)}`)

  return said.length > 0 ? said.join(", ") : "No timings"
}

/**
 * A server's Limits section (lib/core/gate/): whether it is cooling down
 * and why, what it has answered over the last minute, hour and day, and
 * its limits, with your own over PCP's defaults for its kind. Its pace
 * (`pacing`) is here too, so how fast PCP calls it is one place.
 */
export function ServerLimits({
  serverId,
  view,
  pacing,
}: {
  serverId: string
  view: ServerLimitsView
  pacing?: ReactNode
}) {
  const [state, action] = useActionState<LimitsResult, FormData>(
    saveServerLimitsAction,
    { status: "idle" },
  )
  const [inputs, setInputs] = useState<LimitInputs>(() =>
    initialLimitInputs(view.limits.fields),
  )
  const [problem, setProblem] = useState<string | null>(null)
  const [ending, startEnding] = useTransition()
  const [ended, setEnded] = useState<LimitsResult>({ status: "idle" })
  const chosen = limitsFromInputs(view.limits.fields, inputs)
  const own = view.limits.fields.filter((field) => field.value !== undefined)

  return (
    <ListSection
      id="limits"
      title="Limits"
      description="How PCP calls this server, whatever way an assistant calls: calls at once, a pause, a time limit, and a cool-down when it asks PCP to slow down."
    >
      <List>
        {view.cooling ? (
          <ListRow
            title={
              <span className="text-amber-700 dark:text-amber-400">
                Cooling down
              </span>
            }
            description={
              <>
                {view.cooling.reason}. Calls are refused until{" "}
                <LocalDate value={view.cooling.until} />.
              </>
            }
            trailing={
              <Button
                variant="secondary"
                size="sm"
                disabled={ending}
                onClick={() =>
                  startEnding(async () => {
                    setEnded(await endCoolingAction(serverId))
                  })
                }
              >
                End it now
              </Button>
            }
          />
        ) : view.pacing ? (
          <ListRow
            title={
              <span className="text-amber-700 dark:text-amber-400">
                Throttled, pacing
              </span>
            }
            description={
              <>
                {view.pacing.reason}. Its calls still go, one at a time, at
                least {ms(view.pacing.minIntervalMs)} apart, each waited for up
                to {ms(view.pacing.timeoutMs)}; PCP eases off as its answers
                come back clean. Since <LocalDate value={view.pacing.since} />.
              </>
            }
            trailing={
              <Button
                variant="secondary"
                size="sm"
                disabled={ending}
                onClick={() =>
                  startEnding(async () => {
                    setEnded(await endCoolingAction(serverId))
                  })
                }
              >
                Back to normal
              </Button>
            }
          />
        ) : null}
        {view.windows.map((window) => (
          <ListRow
            key={window.label}
            title={window.label}
            description={
              window.calls === 0
                ? "No calls"
                : `${window.errors} failed, ${window.throttles} slow-down${window.throttles === 1 ? "" : "s"}, ${bytes(window.bytes)} back; answers in ${ms(window.p50Ms)} (half), ${ms(window.p95Ms)} (nearly all)`
            }
            trailing={
              <RowValue>
                {window.calls} call{window.calls === 1 ? "" : "s"}
              </RowValue>
            }
          />
        ))}
        <ListRow
          title="Your limits"
          description={
            own.length === 0
              ? "PCP's defaults for its kind."
              : own
                  .map(
                    (field) =>
                      `${field.label}: ${field.value === null || field.value === undefined ? "no cap" : `${shownLimit(field, field.value)}${field.unit === "ms" ? " s" : field.unit === "bytes" ? " KiB" : ""}`}`,
                  )
                  .join("; ")
          }
        />
      </List>
      <FormError error={ended.status === "error" ? ended.error : null} />
      <p className="m-0 text-xs text-muted-foreground">
        Counted since <LocalDate value={view.since} />, or the last day when
        longer; PCP starts counting again when it restarts.
        {view.running > 0
          ? ` ${view.running} running now${view.waiting > 0 ? `, ${view.waiting} waiting` : ""}.`
          : ""}
      </p>
      {view.mailCalls.length > 0 ? (
        <Disclosure
          title="Recent mail calls"
          description="Where each call's time went: connecting, signing in, opening the mailbox, the command and logging out"
        >
          <List>
            {view.mailCalls.map((call, index) => (
              <ListRow
                key={`${call.at}-${index}`}
                title={
                  <>
                    {call.tool ?? "A call"}: {OUTCOME_WORDS[call.outcome]}
                  </>
                }
                description={
                  <>
                    <LocalDate value={call.at} />. {phasesLine(call.phases)}.{" "}
                    {call.reused
                      ? "On a connection an earlier call opened."
                      : "On a new connection."}
                    {call.notices.length > 0
                      ? ` The server said: ${call.notices.join(" / ")}`
                      : ""}
                  </>
                }
              />
            ))}
          </List>
        </Disclosure>
      ) : null}
      <Disclosure
        title="Change limits"
        description="Calls at once, pause, time limit, cool-downs, pacing"
      >
        <form
          action={(formData) => {
            if ("error" in chosen) {
              setProblem(chosen.error)
              return
            }
            setProblem(null)
            formData.set("limits", JSON.stringify(chosen.limits))
            action(formData)
          }}
          className="flex flex-col gap-3"
          aria-label="Limits"
        >
          <input type="hidden" name="serverId" value={serverId} />
          <LimitsFields
            fields={view.limits.fields}
            inputs={inputs}
            onChange={setInputs}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
              Save limits
            </SubmitButton>
            <FormError
              error={problem ?? (state.status === "error" ? state.error : null)}
            />
            <FormNote message={state.status === "ok" ? state.message : null} />
          </div>
        </form>
        {pacing ? (
          <div className="flex flex-col gap-4 border-t border-separator pt-4">
            {pacing}
          </div>
        ) : null}
      </Disclosure>
    </ListSection>
  )
}
