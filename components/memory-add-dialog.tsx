"use client"

import { Plus } from "lucide-react"
import { useActionState, useState } from "react"

import { FormError } from "@/components/form-status"
import { MemoryAlwaysSwitch } from "@/components/memory-always-switch"
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
import { List } from "@/components/ui/list"
import {
  createMemoryAction,
  type MemoryActionResult,
} from "@/lib/actions/memories"
import { MAX_MEMORY_PATH, MAX_SHARED_MEMORY_CHARS } from "@/lib/core/constants"

/**
 * Writing a shared memory yourself: the Memories page's primary action, a
 * sheet over the page. It closes when the memory is saved.
 */
export function MemoryAddDialog() {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        Add a shared memory
      </DialogTrigger>
      <DialogContent>
        <AddMemoryForm onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AddMemoryForm({ onSaved }: { onSaved: () => void }) {
  const [state, action] = useActionState<MemoryActionResult, FormData>(
    async (previous, formData) => {
      const result = await createMemoryAction(previous, formData)

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
        <DialogTitle>Add a shared memory</DialogTitle>
        <DialogDescription>
          Something every assistant should know about you: how you like to work,
          what you are working on, decisions already made.
        </DialogDescription>
      </div>
      <Field
        label="Path"
        htmlFor="memory-path"
        hint="Assistants find it at /memories/shared/ followed by this."
      >
        <Input
          id="memory-path"
          name="path"
          required
          maxLength={MAX_MEMORY_PATH}
          placeholder="preferences.md"
        />
      </Field>
      <Field
        label="Text"
        htmlFor="memory-text"
        hint={`Up to ${MAX_SHARED_MEMORY_CHARS.toLocaleString("en")} characters.`}
      >
        <Textarea
          id="memory-text"
          name="text"
          required
          maxLength={MAX_SHARED_MEMORY_CHARS}
          className="min-h-28"
        />
      </Field>
      <List>
        <MemoryAlwaysSwitch id="memory-always" defaultChecked={false} />
      </List>
      <FormError error={state.status === "error" ? state.error : null} />
      <DialogFooter>
        <DialogClose render={<Button variant="secondary" />}>
          Cancel
        </DialogClose>
        <SubmitButton pendingText="Saving…">Save memory</SubmitButton>
      </DialogFooter>
    </form>
  )
}
