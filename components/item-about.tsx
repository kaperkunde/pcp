"use client"

import { Lock } from "lucide-react"
import Link from "next/link"
import { useId, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { RelativeDate } from "@/components/local-date"
import { Button, ButtonLink } from "@/components/ui/button"
import { serverKindLabel } from "@/components/ui/icon-tile"
import { Input } from "@/components/ui/input"
import { ListRow, RowValue } from "@/components/ui/list"
import {
  detachServerAction,
  setNoteAction,
  type DefinitionActionResult,
} from "@/lib/actions/definitions"
import { MAX_PERSONAL_NOTE } from "@/lib/core/constants"
import type { ItemAbout } from "@/lib/core/item-about"
import type { ServerKind } from "@/lib/core/servers"

/**
 * The rows every item's About card has, whatever it is (an MCP server, an
 * endpoint, a wrapper, a mail or calendar account, a skill): what it is and
 * which definition, where it came from, how it syncs, whether anyone else
 * reads it, the other servers of its definition with Clone and Detach, and
 * the owner's note, private and edited in place. They go inside the About
 * list, after the description.
 */
export function ItemAboutRows({ about }: { about: ItemAbout }) {
  return (
    <>
      <ListRow
        title="Type"
        trailing={
          <RowValue>
            {about.itemKind === "skill"
              ? "Skill"
              : serverKindLabel(about.kind as ServerKind)}
            {about.definition ? (
              <>
                {" · definition "}
                <code className="text-[13px]">{about.definition.slug}</code>
              </>
            ) : null}
          </RowValue>
        }
      />
      <ListRow
        title="Source"
        trailing={
          about.source.kind === "repo" ? (
            <Link
              href={`/settings/repositories/${about.source.repoId}`}
              className="text-[13px] break-all text-primary hover:underline"
            >
              {about.source.repo} · {about.source.path}
            </Link>
          ) : (
            <RowValue>Made here</RowValue>
          )
        }
      />
      <SyncRow about={about} />
      <ListRow
        title="Sharing"
        description="Only in this vault: no one else reads it."
        trailing={<RowValue>Private</RowValue>}
      />
      {about.definition ? <InstancesRow about={about} /> : null}
      <NoteRow about={about} />
    </>
  )
}

const SYNC_STATE: Record<string, string> = {
  ok: "In step",
  review: "A change waits for you",
  conflict: "Conflict",
  local: "Your change is not pushed",
  missing: "Not in the repository",
  error: "Sync failed",
}

const FREQUENCY: Record<string, string> = {
  off: "by hand",
  hourly: "hourly",
  daily: "daily",
  weekly: "weekly",
}

function SyncRow({ about }: { about: ItemAbout }) {
  const sync = about.sync

  if (sync.kind === "local") {
    return <ListRow title="Sync" trailing={<RowValue>Local only</RowValue>} />
  }

  return (
    <ListRow
      title="Sync"
      description={
        <>
          Syncs {FREQUENCY[sync.frequency] ?? sync.frequency}
          {sync.bidirectional ? ", both ways" : ""}
          {sync.lastSyncAt ? (
            <>
              {" "}
              · last <RelativeDate value={sync.lastSyncAt} />
            </>
          ) : null}
        </>
      }
      trailing={<RowValue>{SYNC_STATE[sync.state] ?? sync.state}</RowValue>}
    />
  )
}

/** The servers of the definition, and making another or going alone. */
function InstancesRow({ about }: { about: ItemAbout }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<DefinitionActionResult>({
    status: "idle",
  })
  const others = about.instances.filter((each) => each.id !== about.id)

  function detach() {
    if (
      !window.confirm(
        `Detach this server from ${others.map((each) => each.slug).join(", ")}? It keeps what it has now, and from then on a change to it no longer reaches them, nor theirs it.`,
      )
    ) {
      return
    }

    startTransition(async () => {
      setResult(await detachServerAction(about.id))
    })
  }

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2.5 text-sm">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <span className="text-[15px] leading-snug">Instances</span>
        <span className="text-xs leading-relaxed text-muted-foreground">
          {about.instances.length > 1 ? (
            <>
              Used by{" "}
              {about.instances.map((instance, at) => (
                <span key={instance.id}>
                  {at > 0 ? ", " : ""}
                  {instance.id === about.id ? (
                    <strong className="font-medium text-foreground">
                      {instance.slug}
                    </strong>
                  ) : (
                    <Link
                      href={`/servers/${instance.id}`}
                      className="text-primary hover:underline"
                    >
                      {instance.slug}
                    </Link>
                  )}
                </span>
              ))}
              . They share{" "}
              {about.kind === "openapi"
                ? "the description, schema, edits and tool descriptions"
                : about.kind === "wrapper"
                  ? "the description, programs and tool descriptions"
                  : "the description and tool descriptions"}
              ; each has its own address, secret, levels and note.
            </>
          ) : (
            "Only this one. A clone shares its description and tools, with an address and secret of its own."
          )}
        </span>
        <FormError error={result.status === "error" ? result.error : null} />
        <FormNote message={result.status === "ok" ? result.message : null} />
      </div>
      <span className="flex items-center gap-1">
        {about.canClone ? (
          <ButtonLink
            href={`/servers/${about.id}/clone`}
            variant="ghost"
            size="sm"
          >
            Clone
          </ButtonLink>
        ) : null}
        {others.length > 0 ? (
          <Button variant="plain" size="sm" disabled={pending} onClick={detach}>
            Detach
          </Button>
        ) : null}
      </span>
    </div>
  )
}

/** The owner's note: private, one line, edited where it is. */
function NoteRow({ about }: { about: ItemAbout }) {
  const inputId = useId()
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState(about.note ?? "")
  const [draft, setDraft] = useState(note)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<DefinitionActionResult>({
    status: "idle",
  })

  function save() {
    startTransition(async () => {
      const saved = await setNoteAction(about.itemKind, about.id, draft)
      setResult(saved)

      if (saved.status === "ok") {
        setNote(saved.note ?? "")
        setEditing(false)
      }
    })
  }

  return (
    <div className="flex min-h-14 flex-wrap items-start gap-x-3.5 gap-y-2 px-4 py-3 text-sm">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock aria-hidden className="size-3.5" />
          {editing ? <label htmlFor={inputId}>Your note</label> : "Your note"}
        </span>
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <Input
              id={inputId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MAX_PERSONAL_NOTE}
              autoFocus
              autoComplete="off"
              placeholder="plek.je production, cool.de.plek.je"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save note"}
              </Button>
              <Button
                type="button"
                variant="plain"
                size="sm"
                onClick={() => {
                  setDraft(note)
                  setEditing(false)
                  setResult({ status: "idle" })
                }}
              >
                Cancel
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                {[...draft].length}/{MAX_PERSONAL_NOTE}
              </span>
            </div>
          </form>
        ) : (
          <p
            className={
              note
                ? "text-[15px] leading-snug break-words"
                : "text-[15px] leading-snug text-muted-foreground"
            }
          >
            {note || "No note."}
          </p>
        )}
        <span className="text-xs leading-relaxed text-muted-foreground">
          Private: never synced or shared. Assistants that see this{" "}
          {about.itemKind === "skill" ? "skill" : "server"} read it as your
          note, after the description.
        </span>
        <FormError error={result.status === "error" ? result.error : null} />
        <FormNote message={result.status === "ok" ? result.message : null} />
      </div>
      {editing ? null : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(note)
            setEditing(true)
            setResult({ status: "idle" })
          }}
        >
          Edit note
        </Button>
      )}
    </div>
  )
}
