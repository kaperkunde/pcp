import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { ItemAboutRows } from "@/components/item-about"
import { RelativeDate } from "@/components/local-date"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import {
  SkillDelete,
  SkillEditForm,
  SkillFiles,
} from "@/components/skill-editor"
import { List, ListSection } from "@/components/ui/list"
import { isPcpError } from "@/lib/core/errors"
import { itemAbout } from "@/lib/core/item-about"
import { getSkill, type SkillSummary } from "@/lib/core/skills"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Skill" }

/**
 * One skill: About (what it is, where it came from, how it syncs, your
 * note), its fields to edit, the reference files it carries, its whole
 * SKILL.md as assistants read it, and deleting it, last.
 */
export default async function SkillPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  let skill: SkillSummary

  try {
    skill = await getSkill(ctx, id)
  } catch (error) {
    if (isPcpError(error) && error.code === "not_found") {
      notFound()
    }

    throw error
  }

  const about = await itemAbout(ctx, "skill", skill.id)

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/skills", label: "Skills" }}
        title={skill.name}
        description={
          <>
            Version {skill.version} ·{" "}
            {skill.author === "owner"
              ? "written by you"
              : "written by an assistant, and you agreed"}{" "}
            · updated <RelativeDate value={skill.updatedAt} />
          </>
        }
      />
      <ListSection title="About">
        <List>
          <ItemAboutRows about={about} />
        </List>
      </ListSection>
      <SkillEditForm
        key={skill.version}
        skill={{
          id: skill.id,
          name: skill.name,
          description: skill.description,
          tools: skill.tools,
          body: skill.body,
        }}
      />
      <SkillFiles
        key={`files-${skill.version}`}
        skillId={skill.id}
        files={skill.files}
      />
      <details className="rounded-xl bg-card px-4 py-3">
        <summary className="cursor-pointer text-[13px] text-primary">
          Show its SKILL.md, as assistants read it
        </summary>
        <pre
          className="mt-3 max-h-[32rem] overflow-auto rounded-lg bg-field p-3 text-xs break-words whitespace-pre-wrap"
          data-testid="skill-md"
        >
          {skill.text}
        </pre>
      </details>
      <SkillDelete skillId={skill.id} name={skill.name} />
    </PageColumn>
  )
}
