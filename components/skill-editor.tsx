"use client"

import { useRouter } from "next/navigation"
import { useActionState, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SkillFields } from "@/components/skill-fields"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { ListSection } from "@/components/ui/list"
import {
  deleteSkillAction,
  deleteSkillFileAction,
  saveSkillFileAction,
  updateSkillAction,
  type SkillActionResult,
} from "@/lib/actions/skills"
import {
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FILE_PATH,
  MAX_SKILL_FILES,
} from "@/lib/core/constants"

const IDLE: SkillActionResult = { status: "idle" }

/** A skill's own fields, saved as its next version. */
export function SkillEditForm({
  skill,
}: {
  skill: {
    id: string
    name: string
    description: string
    tools: string[]
    body: string
  }
}) {
  const [state, action] = useActionState(updateSkillAction, IDLE)

  return (
    <ListSection title="The skill">
      <Card>
        <form action={action} className="flex flex-col gap-5">
          <input type="hidden" name="id" value={skill.id} />
          <SkillFields idPrefix="skill" skill={skill} />
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div className="flex justify-end">
            <SubmitButton pendingText="Saving…">Save</SubmitButton>
          </div>
        </form>
      </Card>
    </ListSection>
  )
}

/**
 * The reference files a skill carries, each saved or deleted on its own,
 * and one more to add while there is room. Each change is a new version.
 */
export function SkillFiles({
  skillId,
  files,
}: {
  skillId: string
  files: Array<{ path: string; text: string }>
}) {
  return (
    <ListSection
      title="Files"
      description={`Reference text the skill points to, read by an assistant when a step needs it. Never run. At most ${MAX_SKILL_FILES}.`}
    >
      {files.map((file) => (
        <SkillFileForm key={file.path} skillId={skillId} file={file} />
      ))}
      {files.length < MAX_SKILL_FILES ? (
        <SkillFileForm skillId={skillId} file={null} />
      ) : null}
    </ListSection>
  )
}

function SkillFileForm({
  skillId,
  file,
}: {
  skillId: string
  file: { path: string; text: string } | null
}) {
  const [state, action] = useActionState(saveSkillFileAction, IDLE)
  const [removed, setRemoved] = useState<SkillActionResult>(IDLE)
  const [pending, startTransition] = useTransition()
  const id = file ? `file-${file.path.replace(/[^a-z0-9]/gi, "-")}` : "new-file"

  function remove() {
    if (!file || !window.confirm(`Delete the file ${file.path}?`)) {
      return
    }

    startTransition(async () => {
      setRemoved(await deleteSkillFileAction(skillId, file.path))
    })
  }

  return (
    <Card>
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={skillId} />
        {file ? (
          <input type="hidden" name="previousPath" value={file.path} />
        ) : null}
        <Field
          label={file ? "Path" : "Add a file"}
          htmlFor={`${id}-path`}
          hint={
            file ? undefined : "Its path inside the skill, like reference.md."
          }
        >
          <Input
            id={`${id}-path`}
            name="path"
            required
            maxLength={MAX_SKILL_FILE_PATH}
            defaultValue={file?.path}
            placeholder="reference.md"
            className="font-mono text-[13px]"
          />
        </Field>
        <Field label="Text" htmlFor={`${id}-text`}>
          <Textarea
            id={`${id}-text`}
            name="text"
            required
            maxLength={MAX_SKILL_FILE_CHARS}
            defaultValue={file?.text}
            className="min-h-32 font-mono text-[13px]"
          />
        </Field>
        <FormError
          error={
            state.status === "error"
              ? state.error
              : removed.status === "error"
                ? removed.error
                : null
          }
        />
        <FormNote message={state.status === "ok" ? state.message : null} />
        <div className="flex flex-wrap justify-end gap-2">
          {file ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={remove}
            >
              Delete file
            </Button>
          ) : null}
          <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
            {file ? "Save file" : "Add file"}
          </SubmitButton>
        </div>
      </form>
    </Card>
  )
}

/** Deleting the skill: last on its page, as red text. */
export function SkillDelete({
  skillId,
  name,
}: {
  skillId: string
  name: string
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function remove() {
    if (
      !window.confirm(
        `Delete the skill ${name}? No assistant will see it any more.`,
      )
    ) {
      return
    }

    startTransition(async () => {
      const result = await deleteSkillAction(skillId)

      if (result.status === "error") {
        setError(result.error)
      } else {
        router.push("/skills")
      }
    })
  }

  return (
    <div className="flex flex-col items-center gap-1 pt-2 text-center">
      <Button
        type="button"
        variant="destructive"
        disabled={pending}
        onClick={remove}
      >
        Delete skill
      </Button>
      <p className="text-[13px] text-muted-foreground">
        No assistant sees it any more, and its files go with it.
      </p>
      <FormError error={error} />
    </div>
  )
}
