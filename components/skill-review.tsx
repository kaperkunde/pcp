import { Badge } from "@/components/ui/badge"
import type { DiffLine } from "@/lib/core/line-merge"
import type { SkillShown } from "@/lib/core/skills"
import { cn } from "@/lib/utils"

const CHANGE_LABEL = {
  added: "New file",
  changed: "Changed",
  removed: "Removed",
  same: "Unchanged",
} as const

/**
 * The skill a request is about, whole, as it would be written: its path and
 * versions, what changes against the skill as it is (each line in or out),
 * then the whole SKILL.md and every file. Nothing is folded: the owner reads
 * all of it before agreeing. DESIGN.md › What goes where.
 */
export function SkillReview({ skill }: { skill: SkillShown }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <code className="break-all">/skills/{skill.name}/SKILL.md</code>
        {skill.newName ? (
          <>
            <span aria-hidden>→</span>
            <span className="sr-only">moves to</span>
            <code className="break-all">/skills/{skill.newName}/SKILL.md</code>
          </>
        ) : null}
        {skill.deleting ? (
          <Badge variant="destructive">Deleted</Badge>
        ) : skill.basis === null ? (
          <Badge variant="secondary">New skill</Badge>
        ) : (
          <Badge variant="secondary">
            Version {skill.basis} → {skill.version}
          </Badge>
        )}
      </div>

      {skill.diff ? (
        <figure className="m-0 flex flex-col gap-1.5">
          <figcaption className="text-xs font-medium text-muted-foreground">
            What changes in SKILL.md
          </figcaption>
          <Diff lines={skill.diff} testId="skill-diff" />
        </figure>
      ) : null}

      <figure className="m-0 flex flex-col gap-1.5">
        <figcaption className="text-xs font-medium text-muted-foreground">
          {skill.deleting ? "The skill, as it is now" : "The whole skill after"}
        </figcaption>
        <pre
          className={cn(
            "m-0 max-h-[36rem] overflow-auto rounded-xl p-4 text-[13px] leading-relaxed break-words whitespace-pre-wrap",
            skill.deleting
              ? "border border-dashed border-separator text-muted-foreground"
              : "bg-field ring-1 ring-primary/30",
          )}
          data-testid="skill-text"
        >
          {skill.text}
        </pre>
      </figure>

      {skill.files.map((file) => (
        <figure key={file.path} className="m-0 flex flex-col gap-1.5">
          <figcaption className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            <code className="break-all">{file.path}</code>
            <Badge
              variant={file.change === "removed" ? "destructive" : "secondary"}
            >
              {CHANGE_LABEL[file.change]}
            </Badge>
          </figcaption>
          {file.diff ? (
            <Diff lines={file.diff} />
          ) : (
            <pre
              className={cn(
                "m-0 max-h-96 overflow-auto rounded-xl p-4 text-[13px] break-words whitespace-pre-wrap",
                file.change === "removed"
                  ? "border border-dashed border-separator text-muted-foreground line-through"
                  : "bg-field",
              )}
            >
              {file.text}
            </pre>
          )}
        </figure>
      ))}
    </div>
  )
}

/** Lines in and out, each marked with + or − as well as its colour. */
function Diff({ lines, testId }: { lines: DiffLine[]; testId?: string }) {
  return (
    <div
      className="max-h-[28rem] overflow-auto rounded-xl bg-field py-2 font-mono text-[12px] leading-relaxed"
      data-testid={testId}
    >
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "flex gap-2 px-3 break-words whitespace-pre-wrap",
            line.kind === "added" && "bg-primary/10 text-foreground",
            line.kind === "removed" &&
              "bg-destructive/10 text-muted-foreground",
            line.kind === "same" && "text-muted-foreground/80",
          )}
        >
          <span aria-hidden className="w-3 shrink-0 select-none">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
          </span>
          <span className="sr-only">
            {line.kind === "added"
              ? "Added: "
              : line.kind === "removed"
                ? "Removed: "
                : ""}
          </span>
          <span className="min-w-0">{line.text || " "}</span>
        </div>
      ))}
    </div>
  )
}
