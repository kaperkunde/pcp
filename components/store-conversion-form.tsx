"use client"

import { useActionState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import {
  convertStoreAction,
  type ConvertStoreResult,
} from "@/lib/actions/storage"

/**
 * Encrypting a store, or making it plain again: one batch a click, until
 * it is done. While it is under way, assistants' calls to it wait.
 */
export function StoreConversionForm({
  id,
  to,
  underway,
}: {
  id: string
  /** The mode it goes to. */
  to: "encrypted" | "plain"
  /** A conversion to that mode was started and is not done yet. */
  underway: boolean
}) {
  const [state, action, pending] = useActionState<ConvertStoreResult, FormData>(
    () => convertStoreAction(id, to),
    { status: "idle" },
  )
  const more = underway || (state.status === "ok" && state.done === false)
  const label = pending
    ? to === "encrypted"
      ? "Encrypting…"
      : "Decrypting…"
    : more
      ? "Continue"
      : to === "encrypted"
        ? "Encrypt this folder"
        : "Make it plain"

  return (
    <form action={action} className="flex flex-col items-end gap-1.5">
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={pending || (state.status === "ok" && state.done === true)}
        data-testid={`store-convert-${to}`}
      >
        {label}
      </Button>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </form>
  )
}
