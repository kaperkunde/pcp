import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  MAX_SKILL_BODY,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_NAME,
} from "@/lib/core/constants"

/**
 * A skill's own fields, for adding one and for its page: the name, when to
 * use it, the tools it uses and its steps. Submits as name, description,
 * tools and body.
 */
export function SkillFields({
  idPrefix,
  skill,
}: {
  idPrefix: string
  skill?: { name: string; description: string; tools: string[]; body: string }
}) {
  return (
    <>
      <Field
        label="Name"
        htmlFor={`${idPrefix}-name`}
        hint="Lower-case letters, numbers and hyphens, like release-notes."
      >
        <Input
          id={`${idPrefix}-name`}
          name="name"
          required
          maxLength={MAX_SKILL_NAME}
          defaultValue={skill?.name}
          placeholder="release-notes"
          autoComplete="off"
        />
      </Field>
      <Field
        label="When to use it"
        htmlFor={`${idPrefix}-description`}
        hint="Assistants see this line in every conversation and pick the skill by it."
      >
        <Input
          id={`${idPrefix}-description`}
          name="description"
          required
          maxLength={MAX_SKILL_DESCRIPTION}
          defaultValue={skill?.description}
          placeholder="Write release notes from the pull requests merged since the last release."
        />
      </Field>
      <Field
        label="Tools it uses"
        htmlFor={`${idPrefix}-tools`}
        hint="One server/tool per line, like github/list_pull_requests. Optional: an assistant gets each one ready to call with the skill."
      >
        <Textarea
          id={`${idPrefix}-tools`}
          name="tools"
          defaultValue={skill?.tools.join("\n")}
          className="min-h-16 font-mono text-[13px]"
        />
      </Field>
      <Field
        label="Steps"
        htmlFor={`${idPrefix}-body`}
        hint={`Markdown, up to ${MAX_SKILL_BODY.toLocaleString("en")} characters.`}
      >
        <Textarea
          id={`${idPrefix}-body`}
          name="body"
          required
          maxLength={MAX_SKILL_BODY}
          defaultValue={skill?.body}
          className="min-h-48 font-mono text-[13px]"
          placeholder={
            "1. List the pull requests merged since the last tag.\n2. Group them by area.\n3. …"
          }
        />
      </Field>
    </>
  )
}
