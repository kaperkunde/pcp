"use client"

import { FileUp, Plus } from "lucide-react"
import { useRouter } from "next/navigation"
import { useActionState, useState } from "react"

import { FormError } from "@/components/form-status"
import { SkillFields } from "@/components/skill-fields"
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
import { Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  createSkillAction,
  importSkillAction,
  type SkillActionResult,
} from "@/lib/actions/skills"

/**
 * The Skills page's actions: writing a skill (the primary one) and pasting a
 * SKILL.md, whose frontmatter fills in the name and description. Either
 * opens the new skill's page once it is saved.
 */
export function SkillAddDialog() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ImportDialog />
      <AddDialog />
    </div>
  )
}

function useCreated(
  run: (
    previous: SkillActionResult,
    formData: FormData,
  ) => Promise<SkillActionResult>,
) {
  const router = useRouter()

  return useActionState<SkillActionResult, FormData>(
    async (previous, formData) => {
      const result = await run(previous, formData)

      if (result.status === "ok" && result.id) {
        router.push(`/skills/${result.id}`)
      }

      return result
    },
    { status: "idle" },
  )
}

function AddDialog() {
  const [open, setOpen] = useState(false)
  const [state, action] = useCreated(createSkillAction)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        Add a skill
      </DialogTrigger>
      <DialogContent>
        <form action={action} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <DialogTitle>Add a skill</DialogTitle>
            <DialogDescription>
              A procedure your assistants follow when a task matches: how you
              want a kind of task done, step by step.
            </DialogDescription>
          </div>
          <SkillFields idPrefix="new-skill" />
          <FormError error={state.status === "error" ? state.error : null} />
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>
              Cancel
            </DialogClose>
            <SubmitButton pendingText="Saving…">Save skill</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ImportDialog() {
  const [open, setOpen] = useState(false)
  const [state, action] = useCreated(importSkillAction)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="secondary" />}>
        <FileUp aria-hidden />
        Import a SKILL.md
      </DialogTrigger>
      <DialogContent>
        <form action={action} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <DialogTitle>Import a SKILL.md</DialogTitle>
            <DialogDescription>
              Paste a skill written for Claude or another assistant. Its
              frontmatter gives the name and the description; the rest are its
              steps. Nothing in it is ever run.
            </DialogDescription>
          </div>
          <Field
            label="SKILL.md"
            htmlFor="import-skill-text"
            hint="It starts with --- and a name: line."
          >
            <Textarea
              id="import-skill-text"
              name="text"
              required
              className="min-h-64 font-mono text-[13px]"
              placeholder={
                "---\nname: release-notes\ndescription: Write release notes from merged pull requests.\n---\n\n1. …"
              }
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>
              Cancel
            </DialogClose>
            <SubmitButton pendingText="Importing…">Import skill</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
