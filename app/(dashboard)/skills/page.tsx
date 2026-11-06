import { ListChecks } from "lucide-react"
import type { Metadata } from "next"

import { PageHeader } from "@kaperkunde/ui/page"
import { SkillAddDialog } from "@/components/skill-add-dialog"
import { Badge } from "@kaperkunde/ui/badge"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListRow, ListSection, RowValue } from "@kaperkunde/ui/list"
import { listSkills } from "@/lib/core/skills"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Skills" }

/**
 * The owner's skills: procedures assistants follow when a task matches.
 * Each one opens on a page of its own, where it is edited. An assistant's
 * own skills (lib/core/skills.ts, /skills/mine/) are listed too, marked
 * with the token that keeps them.
 */
export default async function SkillsPage() {
  const ctx = await requireContext()
  const skills = await listSkills(ctx)

  return (
    <>
      <PageHeader
        title="Skills"
        description="Procedures your assistants follow when a task matches: how you want a kind of task done. Each assistant sees them by name and description, and reads one whole before such a task. An assistant changes a skill only after you agree to exactly what it would become. An assistant that keeps memories may also keep skills of its own, which only it sees, marked here with its name."
        action={<SkillAddDialog />}
      />
      <ListSection
        title={skills.length === 1 ? "1 skill" : `${skills.length} skills`}
        footer={
          skills.length > 0
            ? "On an assistant's page you choose whether it sees every skill or only some."
            : null
        }
      >
        {skills.length === 0 ? (
          <List>
            <ListRow
              title="No skills yet"
              description="Add one, or import a SKILL.md written for Claude or another assistant."
            />
          </List>
        ) : (
          <List as="ul">
            {skills.map((skill) => (
              <ListRow
                key={skill.id}
                as="li"
                href={`/skills/${skill.id}`}
                icon={<IconTile icon={ListChecks} />}
                title={
                  skill.visibility === "private" ? (
                    <span className="flex flex-wrap items-center gap-2">
                      {skill.name}
                      <Badge variant="secondary">
                        {skill.tokenName
                          ? `${skill.tokenName}'s own`
                          : "From a deleted token"}
                      </Badge>
                    </span>
                  ) : (
                    skill.name
                  )
                }
                description={skill.description}
                trailing={<RowValue>Version {skill.version}</RowValue>}
              />
            ))}
          </List>
        )}
      </ListSection>
    </>
  )
}
