"use client"

import Link from "next/link"
import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { MemoryAlwaysSwitch } from "@/components/memory-always-switch"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { SwitchRow } from "@/components/ui/switch"
import {
  deleteMemoriesAction,
  deleteMemoryAction,
  setMemoriesAccessAction,
  updateMemoryAction,
  type MemoryActionResult,
} from "@/lib/actions/memories"
import {
  MAX_MEMORY_CHARS,
  MAX_MEMORY_PATH,
  MAX_SHARED_MEMORY_CHARS,
} from "@/lib/core/constants"
import type { MemorySummary } from "@/lib/core/memories"

/** A token a memory can be given to: alive, and keeping memories. */
export type MemoryReader = { id: string; name: string }

type OnPick = (ids: string[], on: boolean) => void

/**
 * The memories, in two groups: the ones every assistant reads (shared), and
 * the ones one assistant keeps for itself. Each row shows who wrote it and
 * whether it is read in every conversation; Edit opens the whole memory.
 * Ticking rows lets the owner change who reads them, or delete them, together.
 */
export function MemoriesManager({
  memories,
  readers,
}: {
  memories: MemorySummary[]
  readers: MemoryReader[]
}) {
  const shared = memories.filter((memory) => memory.visibility === "shared")
  const kept = memories.filter((memory) => memory.visibility === "private")
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // A memory deleted elsewhere while the page was open drops out of the pick.
  const chosen = memories.filter((memory) => picked.has(memory.id))

  const pick: OnPick = (ids, on) => {
    setPicked((previous) => {
      const next = new Set(previous)

      for (const id of ids) {
        if (on) {
          next.add(id)
        } else {
          next.delete(id)
        }
      }

      return next
    })
  }

  return (
    <>
      {memories.length > 0 || note ? (
        <BulkBar
          memories={memories}
          chosen={chosen}
          readers={readers}
          picked={picked}
          pick={pick}
          error={error}
          note={note}
          done={(result) => {
            setError(result.error)
            setNote(result.note)

            if (!result.error) {
              setPicked(new Set())
            }
          }}
        />
      ) : null}
      <ListSection
        title={`Shared with all your assistants (${shared.length})`}
        description="Every assistant whose token can keep memories reads these, at /memories/shared/. You wrote them, or agreed when an assistant asked to share them."
        action={
          <SelectAll
            label="Select all shared"
            ids={shared.map((memory) => memory.id)}
            picked={picked}
            pick={pick}
          />
        }
      >
        <MemoryList
          memories={shared}
          picked={picked}
          pick={pick}
          empty="Nothing shared yet. Add a memory, or agree when an assistant asks to share one."
        />
      </ListSection>
      <ListSection
        title={`Kept by one assistant (${kept.length})`}
        description="Only the assistant that wrote one reads it, at /memories/. It needs nobody's say to write them, so look here now and then."
        action={
          <SelectAll
            label="Select all kept"
            ids={kept.map((memory) => memory.id)}
            picked={picked}
            pick={pick}
          />
        }
      >
        <MemoryList
          memories={kept}
          picked={picked}
          pick={pick}
          empty="No assistant has kept a memory yet."
        />
      </ListSection>
    </>
  )
}

/** A checkbox for a set of memories: ticked when all are picked, dashed when some are. */
function SelectAll({
  label,
  ids,
  picked,
  pick,
}: {
  label: string
  ids: string[]
  picked: ReadonlySet<string>
  pick: OnPick
}) {
  const ref = useRef<HTMLInputElement>(null)
  const count = ids.filter((id) => picked.has(id)).length
  const all = ids.length > 0 && count === ids.length

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = count > 0 && !all
    }
  }, [count, all])

  if (ids.length === 0) {
    return null
  }

  return (
    <Label className="font-normal text-muted-foreground">
      <Checkbox
        ref={ref}
        checked={all}
        onChange={(event) => pick(ids, event.target.checked)}
      />
      {label}
    </Label>
  )
}

/** What a bulk action tells the page when it is done. */
type BulkResult = { error: string | null; note: string | null }

const memoriesOf = (count: number) => (count === 1 ? "memory" : "memories")

/**
 * What the owner does to the ticked memories together: give them to all
 * tokens or to one, or delete them. Who reads a memory is the only thing
 * that changes; the words stay as they are.
 */
function BulkBar({
  memories,
  chosen,
  readers,
  picked,
  pick,
  error,
  note,
  done,
}: {
  memories: MemorySummary[]
  chosen: MemorySummary[]
  readers: MemoryReader[]
  picked: ReadonlySet<string>
  pick: OnPick
  error: string | null
  note: string | null
  done: (result: BulkResult) => void
}) {
  const [access, setAccess] = useState("all")
  const [pending, startTransition] = useTransition()
  const ids = chosen.map((memory) => memory.id)
  const reader = readers.find((item) => item.id === access)
  // A token that stopped keeping memories while the page was open is not one.
  const target = reader ? reader.id : "all"
  const some = ids.length > 0
  const these = `${ids.length} ${memoriesOf(ids.length)}`
  const them = ids.length === 1 ? "it" : "them"

  function run(
    ask: string,
    action: () => ReturnType<typeof deleteMemoriesAction>,
  ) {
    if (!window.confirm(ask)) {
      return
    }

    startTransition(async () => {
      const result = await action()

      done(
        result.status === "error"
          ? { error: result.error, note: null }
          : {
              error: null,
              note: result.status === "ok" ? (result.message ?? null) : null,
            },
      )
    })
  }

  return (
    <Card className="sticky top-2 z-10 gap-3 py-3" data-testid="memories-bulk">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SelectAll
          label="Select all"
          ids={memories.map((memory) => memory.id)}
          picked={picked}
          pick={pick}
        />
        <span className="text-muted-foreground" aria-live="polite">
          {some ? `${ids.length} selected` : "None selected"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Label className="sr-only" htmlFor="memories-access">
            Who reads the selected memories
          </Label>
          <Select
            id="memories-access"
            className="h-9 w-auto"
            value={target}
            onChange={(event) => setAccess(event.target.value)}
          >
            <option value="all">All tokens (shared)</option>
            {readers.map((item) => (
              <option key={item.id} value={item.id}>
                Only {item.name}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            disabled={!some || pending}
            onClick={() =>
              run(
                reader
                  ? `Give ${these} to ${reader.name} alone? Only that token reads ${them} afterwards. Ones marked to be read in every conversation lose that mark when their readers change.`
                  : `Share ${these} with all tokens? Every assistant whose token keeps memories will read ${them} and may act on ${them}. Ones marked to be read in every conversation lose that mark when their readers change.`,
                () => setMemoriesAccessAction(ids, target),
              )
            }
          >
            Give access
          </Button>
          <Button
            variant="destructive"
            disabled={!some || pending}
            onClick={() =>
              run(`Delete ${these}? This cannot be undone.`, () =>
                deleteMemoriesAction(ids),
              )
            }
          >
            Delete selected
          </Button>
        </div>
      </div>
      <FormError error={error} />
      <FormNote message={note} />
    </Card>
  )
}

function MemoryList({
  memories,
  picked,
  pick,
  empty,
}: {
  memories: MemorySummary[]
  picked: ReadonlySet<string>
  pick: OnPick
  empty: string
}) {
  if (memories.length === 0) {
    return (
      <Card>
        <p className="text-muted-foreground">{empty}</p>
      </Card>
    )
  }

  return (
    <List as="ul">
      {memories.map((memory) => (
        <MemoryRow
          key={memory.id}
          memory={memory}
          picked={picked.has(memory.id)}
          pick={pick}
        />
      ))}
    </List>
  )
}

function Writer({ memory }: { memory: MemorySummary }) {
  if (memory.author === "owner") {
    return <>you</>
  }

  if (!memory.tokenId || !memory.tokenName) {
    return <>an assistant whose token was deleted</>
  }

  return (
    <>
      the token{" "}
      <Link href={`/tokens/${memory.tokenId}`} className="underline">
        {memory.tokenName}
      </Link>
      {memory.tokenRevoked ? " (revoked)" : null}
    </>
  )
}

function MemoryRow({
  memory,
  picked,
  pick,
}: {
  memory: MemorySummary
  picked: boolean
  pick: OnPick
}) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [state, action] = useActionState<MemoryActionResult, FormData>(
    updateMemoryAction,
    { status: "idle" },
  )
  const id = `memory-${memory.id}`
  // Only an assistant's own memory can be kept for it alone.
  const canBePrivate = memory.tokenId !== null

  function remove() {
    if (!window.confirm(`Delete the memory ${memory.fullPath}?`)) {
      return
    }

    startTransition(async () => {
      const result = await deleteMemoryAction(memory.id)
      if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  return (
    <ListRow
      as="li"
      data-testid="memory"
      className="items-start py-3.5"
      icon={
        <Checkbox
          className="mt-0.5"
          aria-label={`Select ${memory.fullPath}`}
          checked={picked}
          onChange={(event) => pick([memory.id], event.target.checked)}
        />
      }
      title={
        <span className="flex flex-wrap items-center gap-2">
          <code className="font-medium break-all">{memory.fullPath}</code>
          {memory.visibility === "shared" ? (
            <Badge>Shared</Badge>
          ) : memory.tokenName ? (
            <Badge variant="outline">Only {memory.tokenName}</Badge>
          ) : null}
          {memory.always ? (
            <Badge variant="secondary">Every conversation</Badge>
          ) : null}
        </span>
      }
      description={
        <>
          Written by <Writer memory={memory} /> · updated{" "}
          <LocalDate value={memory.updatedAt} />
          {memory.visibility === "private" &&
          memory.author === "owner" &&
          memory.tokenName
            ? ` · kept for ${memory.tokenName}`
            : null}
        </>
      }
      trailing={
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={remove}
          >
            Delete
          </Button>
        </div>
      }
    >
      <div className="order-last flex basis-full flex-col gap-3">
        {editing ? (
          <form
            action={action}
            className="flex flex-col gap-4 rounded-xl bg-field p-4 ring-1 ring-separator"
          >
            <input type="hidden" name="id" value={memory.id} />
            <Field
              label="Path"
              htmlFor={`${id}-path`}
              hint="Inside /memories/, or /memories/shared/ when shared."
            >
              <Input
                id={`${id}-path`}
                name="path"
                required
                maxLength={MAX_MEMORY_PATH}
                defaultValue={memory.path}
              />
            </Field>
            <Field
              label="Text"
              htmlFor={`${id}-text`}
              hint={`Up to ${MAX_SHARED_MEMORY_CHARS.toLocaleString("en")} characters when shared or read in every conversation, ${MAX_MEMORY_CHARS.toLocaleString("en")} otherwise.`}
            >
              <Textarea
                id={`${id}-text`}
                name="text"
                required
                maxLength={MAX_MEMORY_CHARS}
                defaultValue={memory.text}
                className="min-h-32"
              />
            </Field>
            <List>
              <SwitchRow
                id={`${id}-shared`}
                name="shared"
                label="Shared with all your assistants"
                description={
                  canBePrivate
                    ? `Switched off, only ${memory.tokenName ?? "the assistant that wrote it"} reads it.`
                    : "No assistant's token is behind this one, so it stays shared."
                }
                defaultChecked={memory.visibility === "shared"}
                disabled={!canBePrivate}
              />
              <MemoryAlwaysSwitch
                id={`${id}-always`}
                defaultChecked={memory.always}
              />
            </List>
            {canBePrivate ? null : (
              // A disabled switch is not sent; this keeps it shared.
              <input type="hidden" name="shared" value="on" />
            )}
            <FormError error={state.status === "error" ? state.error : null} />
            <FormNote message={state.status === "ok" ? state.message : null} />
            <div>
              <SubmitButton pendingText="Saving…">Save</SubmitButton>
            </div>
          </form>
        ) : (
          <pre className="m-0 max-h-64 overflow-auto rounded-xl bg-field p-3.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap ring-1 ring-separator">
            {memory.text}
          </pre>
        )}
        <FormError error={error} />
      </div>
    </ListRow>
  )
}
