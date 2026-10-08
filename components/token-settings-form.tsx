"use client"

import { useActionState, useState, type FormEvent, type ReactNode } from "react"
import { useFormStatus } from "react-dom"

import { FormError, FormNote } from "@/components/form-status"
import { OwnerConfirmFields } from "@/components/owner-confirm-fields"
import {
  TOKEN_OPTION_NAMES,
  type TokenOption,
} from "@/components/token-options"
import { Button } from "@/components/ui/button"
import { updateTokenAction, type UpdateTokenResult } from "@/lib/actions/tokens"
import type { ApiTokenSummary } from "@/lib/core/api-tokens"
import { cn } from "@/lib/utils"

/** The settings updateTokenAction writes, apart from the expiry. */
export type TokenSettings = Pick<
  ApiTokenSummary,
  "id" | "name" | "allowAllServers" | "servers" | TokenOption
>

/** What a form shows; everything else it sends unchanged. */
export type TokenSettingsField = "name" | "expires" | "scope" | TokenOption

/**
 * A form for some of a token's settings, saved with its own button.
 * updateTokenAction writes every setting at once, so the ones this form
 * does not show go along as they are now (and the expiry as "keep"): saving
 * the switches on the assistant's page leaves its name and expiry alone.
 * The button wakes up once something in the form changed.
 *
 * A new expiry for a token that has expired brings it back, so (as making a
 * token does) PCP asks for the owner first: what the form chose waits while
 * a second form, holding the account and password and nothing else, asks
 * (updateTokenAction checks it either way).
 */
export function TokenSettingsForm({
  token,
  shows,
  locked,
  saveLabel = "Save",
  expired = false,
  username,
  className,
  children,
}: {
  token: TokenSettings
  shows: TokenSettingsField[]
  locked: boolean
  /** The button's words, where a page has more than one of these forms. */
  saveLabel?: string
  /** The token has expired: a new expiry asks for the owner. */
  expired?: boolean
  /** The account the password step names. */
  username?: string
  className?: string
  children: ReactNode
}) {
  const [changed, setChanged] = useState(false)
  // What the form chose, while the password step asks.
  const [draft, setDraft] = useState<Array<[string, string]> | null>(null)
  const [state, action] = useActionState<UpdateTokenResult, FormData>(
    async (previous, formData) => {
      const result = await updateTokenAction(previous, formData)
      if (result.status === "ok") {
        setChanged(false)
        setDraft(null)
      }
      return result
    },
    { status: "idle" },
  )
  const error = state.status === "error" ? state.error : null

  function review(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget)
    const expiresIn = data.get("expiresIn")

    if (!expired || expiresIn === null || expiresIn === "keep") {
      return
    }

    event.preventDefault()
    const entries: Array<[string, string]> = []
    for (const [key, value] of data) {
      if (typeof value === "string") entries.push([key, value])
    }
    setDraft(entries)
  }

  return (
    <>
      <form
        action={action}
        onSubmit={review}
        onChange={() => setChanged(true)}
        className={cn("flex flex-col gap-3", className)}
      >
        <input type="hidden" name="id" value={token.id} />
        {shows.includes("name") ? null : (
          <input type="hidden" name="name" value={token.name} />
        )}
        {shows.includes("expires") ? null : (
          <input type="hidden" name="expiresIn" value="keep" />
        )}
        {shows.includes("scope") ? null : (
          <>
            <input
              type="hidden"
              name="access"
              value={token.allowAllServers ? "all" : "selected"}
            />
            {token.servers.map((server) => (
              <input
                key={server.id}
                type="hidden"
                name="serverIds"
                value={server.id}
              />
            ))}
          </>
        )}
        {TOKEN_OPTION_NAMES.filter(
          (option) => !shows.includes(option) && token[option],
        ).map((option) => (
          <input key={option} type="hidden" name={option} value="on" />
        ))}
        <fieldset disabled={locked || draft !== null} className="m-0 contents">
          {children}
        </fieldset>
        {locked || draft !== null ? null : (
          <div className="flex flex-wrap items-center justify-end gap-3 px-1">
            <FormError error={error} />
            <FormNote
              message={state.status === "ok" && !changed ? state.message : null}
            />
            <SaveButton changed={changed} label={saveLabel} />
          </div>
        )}
      </form>
      {draft !== null ? (
        <form
          action={action}
          className="flex flex-col gap-4 rounded-xl bg-card p-5"
        >
          <p className="leading-relaxed text-muted-foreground">
            This token has expired. A new expiry makes it work again, so PCP
            asks for your password first.
          </p>
          {draft.map(([key, value], index) => (
            <input key={index} type="hidden" name={key} value={value} />
          ))}
          <OwnerConfirmFields
            idPrefix="token-revive"
            username={username ?? ""}
            error={error}
            autoFocus
          />
          <FormError error={error} />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDraft(null)}
            >
              Back
            </Button>
            <ConfirmButton />
          </div>
        </form>
      ) : null}
    </>
  )
}

function ConfirmButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Checking…" : "Confirm"}
    </Button>
  )
}

function SaveButton({ changed, label }: { changed: boolean; label: string }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending || !changed}>
      {pending ? "Saving…" : label}
    </Button>
  )
}
