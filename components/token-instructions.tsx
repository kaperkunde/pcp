"use client"

import { useActionState, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/input"
import {
  keepInstructionsAction,
  saveInstructionsAction,
  takeInstructionsAction,
  type UpdateTokenResult,
} from "@/lib/actions/tokens"
import { MAX_INSTRUCTIONS_CHARS } from "@/lib/core/constants"

/**
 * The owner's instructions for one assistant, on its Advanced page: what it
 * is given at the start of every conversation. A token without its own
 * shows PCP's suggestion, marked as not set yet: it gets nothing until the
 * owner saves.
 */
export function TokenInstructionsEditor({
  tokenId,
  text,
  saved,
  locked,
}: {
  tokenId: string
  text: string
  saved: boolean
  locked: boolean
}) {
  const [value, setValue] = useState(text)
  const [state, action] = useActionState<UpdateTokenResult, FormData>(
    saveInstructionsAction,
    { status: "idle" },
  )
  const changed = value !== text || !saved

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={tokenId} />
      {saved ? null : (
        <p className="text-[13px] leading-relaxed text-warning">
          Not set yet: this is PCP&apos;s suggestion, and the assistant gets
          none of it until you save.
        </p>
      )}
      <label htmlFor="token-instructions" className="sr-only">
        Instructions
      </label>
      <Textarea
        id="token-instructions"
        name="instructions"
        rows={10}
        maxLength={MAX_INSTRUCTIONS_CHARS}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={locked}
        className="font-mono text-[13px] leading-relaxed"
      />
      {locked ? null : (
        <div className="flex flex-wrap items-center justify-end gap-3 px-1">
          <span className="mr-auto text-xs text-muted-foreground">
            {value.length.toLocaleString("en")} of{" "}
            {MAX_INSTRUCTIONS_CHARS.toLocaleString("en")} characters
          </span>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          {changed ? (
            <SubmitButton pendingText="Saving…">Save instructions</SubmitButton>
          ) : null}
        </div>
      )}
    </form>
  )
}

/**
 * One assistant whose instructions follow an older suggestion than PCP's
 * now: keep its own, take PCP's, or merge the two in an editor that starts
 * from the merge (with the places that need the owner marked).
 */
export function InstructionsUpdate({
  tokenId,
  tokenName,
  mine,
  theirs,
  merged,
  conflicts,
}: {
  tokenId: string
  tokenName: string
  mine: string
  theirs: string
  merged: string
  conflicts: number
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [state, action] = useActionState<UpdateTokenResult, FormData>(
    saveInstructionsAction,
    { status: "idle" },
  )

  function run(
    choose: (id: string) => ReturnType<typeof keepInstructionsAction>,
  ) {
    setError(null)
    startTransition(async () => {
      const result = await choose(tokenId)
      if (result.status === "error") setError(result.error)
    })
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-card p-5">
      <h2 className="text-[17px] leading-snug font-semibold">{tokenName}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold text-muted-foreground">
            Yours now
          </h3>
          <pre className="overflow-x-auto rounded-lg bg-field p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {mine || "(empty)"}
          </pre>
        </section>
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold text-muted-foreground">
            PCP&apos;s suggestion now
          </h3>
          <pre className="overflow-x-auto rounded-lg bg-field p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {theirs}
          </pre>
        </section>
      </div>

      <form action={action} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={tokenId} />
        <input type="hidden" name="merged" value="on" />
        <label
          htmlFor={`merge-${tokenId}`}
          className="text-[13px] font-semibold text-muted-foreground"
        >
          Merged
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {conflicts === 0
            ? "Your changes and PCP's, together. Change anything before you save."
            : `${conflicts} place${conflicts === 1 ? "" : "s"} changed on both sides, marked from <<<<<<< Yours to >>>>>>> PCP's suggestion: keep what you want of each and take the marker lines out.`}
        </p>
        <Textarea
          id={`merge-${tokenId}`}
          name="instructions"
          rows={10}
          maxLength={MAX_INSTRUCTIONS_CHARS}
          defaultValue={merged}
          className="font-mono text-[13px] leading-relaxed"
        />
        <div className="flex flex-wrap items-center justify-end gap-3">
          <FormError
            error={error ?? (state.status === "error" ? state.error : null)}
          />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => run(keepInstructionsAction)}
          >
            Keep mine
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => run(takeInstructionsAction)}
          >
            Take PCP&apos;s
          </Button>
          <SubmitButton pendingText="Saving…">Save merged</SubmitButton>
        </div>
      </form>
    </div>
  )
}
