"use client"

import { Plus } from "lucide-react"
import { useActionState, useState } from "react"

import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  createSecretAction,
  type SecretActionResult,
} from "@/lib/actions/secrets"

/**
 * Adding a secret: the Secrets page's primary action, a sheet over the
 * page. It closes when the secret is saved.
 */
export function SecretAddDialog() {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        Add a secret
      </DialogTrigger>
      <DialogContent>
        <AddSecretForm onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AddSecretForm({ onSaved }: { onSaved: () => void }) {
  const [state, action] = useActionState<SecretActionResult, FormData>(
    async (previous, formData) => {
      const result = await createSecretAction(previous, formData)

      if (result.status === "ok") {
        onSaved()
      }

      return result
    },
    { status: "idle" },
  )

  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <DialogTitle>Add a secret</DialogTitle>
        <DialogDescription>
          An API key, a personal access token, a password: whatever an MCP
          server needs to be sent. It is encrypted, and only ever sent to the
          server that uses it.
        </DialogDescription>
      </div>
      <Field label="Name" htmlFor="secret-name">
        <Input
          id="secret-name"
          name="name"
          required
          maxLength={100}
          placeholder="GitHub token"
        />
      </Field>
      <Field label="Description (optional)" htmlFor="secret-description">
        <Input
          id="secret-description"
          name="description"
          maxLength={500}
          placeholder="Personal access token, repo scope"
        />
      </Field>
      <Field label="Value" htmlFor="secret-value">
        <Textarea
          id="secret-value"
          name="value"
          required
          autoComplete="off"
          spellCheck={false}
          className="min-h-16 font-mono"
        />
      </Field>
      <FormError error={state.status === "error" ? state.error : null} />
      <DialogFooter>
        <DialogClose render={<Button variant="secondary" />}>
          Cancel
        </DialogClose>
        <SubmitButton pendingText="Saving…">Save secret</SubmitButton>
      </DialogFooter>
    </form>
  )
}
