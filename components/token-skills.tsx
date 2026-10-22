"use client"

import { ListChecks } from "lucide-react"
import Link from "next/link"
import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { IconTile } from "@/components/ui/icon-tile"
import { Checkbox } from "@/components/ui/input"
import { List, ListSection } from "@/components/ui/list"
import { SegmentedControl } from "@/components/ui/segmented-control"
import {
  setTokenSkillsAction,
  type SkillActionResult,
} from "@/lib/actions/skills"

type Scope = "all" | "selected"

/**
 * Which skills an assistant sees: every one (including ones added later),
 * or the ones ticked, as a token's servers are chosen. Saved on its own.
 */
export function TokenSkillsForm({
  tokenId,
  skills,
  all,
  selected,
  locked,
}: {
  tokenId: string
  skills: Array<{ id: string; name: string; description: string }>
  all: boolean
  selected: string[]
  locked: boolean
}) {
  const [scope, setScope] = useState<Scope>(all ? "all" : "selected")
  const [changed, setChanged] = useState(false)
  const [state, action] = useActionState<SkillActionResult, FormData>(
    async (previous, formData) => {
      const result = await setTokenSkillsAction(previous, formData)
      if (result.status === "ok") {
        setChanged(false)
      }
      return result
    },
    { status: "idle" },
  )

  return (
    <form
      action={action}
      onChange={() => setChanged(true)}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="tokenId" value={tokenId} />
      <ListSection
        title="Skills"
        description={
          <>
            Procedures it follows when a task matches. You write them under{" "}
            <Link href="/skills" className="text-primary">
              Skills
            </Link>
            .
          </>
        }
      >
        <List>
          <div className="flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2.5">
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
              <span className="text-[15px] leading-snug">Skills it sees</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {scope === "all"
                  ? "Every skill, including ones you add later."
                  : "Only the skills ticked below."}
              </span>
            </div>
            <SegmentedControl<Scope>
              name="skills"
              legend="Skills it sees"
              value={scope}
              onValueChange={(value) => {
                setScope(value)
                setChanged(true)
              }}
              disabled={locked}
              options={[
                { value: "all", label: "All skills" },
                { value: "selected", label: "Only some" },
              ]}
            />
          </div>
          {scope === "selected" ? (
            skills.length === 0 ? (
              <p className="px-4 py-3 pl-6 text-[13px] text-muted-foreground">
                No skills to choose from yet.
              </p>
            ) : (
              <div className="flex flex-col divide-y divide-separator">
                {skills.map((skill) => (
                  <label
                    key={skill.id}
                    className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 pl-6"
                  >
                    <IconTile icon={ListChecks} size="sm" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{skill.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    </span>
                    <Checkbox
                      name="skillIds"
                      value={skill.id}
                      defaultChecked={selected.includes(skill.id)}
                      disabled={locked}
                      aria-label={skill.name}
                    />
                  </label>
                ))}
              </div>
            )
          ) : null}
        </List>
      </ListSection>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote
        message={state.status === "ok" && !changed ? state.message : null}
      />
      {!locked ? (
        <div className="flex justify-end">
          <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
            Save skills
          </SubmitButton>
        </div>
      ) : null}
    </form>
  )
}
