"use client"

import { useActionState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { updateBrowserAction } from "@/lib/actions/browser"
import type { ActionState } from "@/lib/server/action-state"

/**
 * The browser's name and description, what assistants read: on the Browser
 * page and under its server page's Advanced.
 */
export function BrowserDescribeForm({
  name,
  description,
}: {
  name: string
  description: string
}) {
  const [state, action] = useActionState<
    ActionState<{ message: string }>,
    FormData
  >(updateBrowserAction, { status: "idle" })

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label="Name" htmlFor="browser-name">
        <Input
          id="browser-name"
          name="name"
          defaultValue={name}
          maxLength={80}
          required
        />
      </Field>
      <Field
        label="Description"
        htmlFor="browser-description"
        hint="What assistants read when they look for a tool."
      >
        <Textarea
          id="browser-description"
          name="description"
          defaultValue={description}
          maxLength={1000}
          rows={3}
        />
      </Field>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
      <div>
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
      </div>
    </form>
  )
}
