"use client"

import { useActionState, useState, type ReactNode } from "react"
import { useFormStatus } from "react-dom"

import { FormError, FormNote } from "@/components/form-status"
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
 */
export function TokenSettingsForm({
  token,
  shows,
  locked,
  saveLabel = "Save",
  className,
  children,
}: {
  token: TokenSettings
  shows: TokenSettingsField[]
  locked: boolean
  /** The button's words, where a page has more than one of these forms. */
  saveLabel?: string
  className?: string
  children: ReactNode
}) {
  const [changed, setChanged] = useState(false)
  const [state, action] = useActionState<UpdateTokenResult, FormData>(
    async (previous, formData) => {
      const result = await updateTokenAction(previous, formData)
      if (result.status === "ok") setChanged(false)
      return result
    },
    { status: "idle" },
  )

  return (
    <form
      action={action}
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
      <fieldset disabled={locked} className="m-0 contents">
        {children}
      </fieldset>
      {locked ? null : (
        <div className="flex flex-wrap items-center justify-end gap-3 px-1">
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote
            message={state.status === "ok" && !changed ? state.message : null}
          />
          <SaveButton changed={changed} label={saveLabel} />
        </div>
      )}
    </form>
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
