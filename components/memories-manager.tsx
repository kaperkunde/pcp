"use client"

import Link from "next/link"
import { useActionState, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { MemoryAlwaysSwitch } from "@/components/memory-always-switch"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List, ListRow, ListSection } from "@/components/ui/list"
import { SwitchRow } from "@/components/ui/switch"
import {
  deleteMemoryAction,
  updateMemoryAction,
  type MemoryActionResult,
} from "@/lib/actions/memories"
import {
  MAX_MEMORY_CHARS,
  MAX_MEMORY_PATH,
  MAX_SHARED_MEMORY_CHARS,
} from "@/lib/core/constants"
import type { MemorySummary } from "@/lib/core/memories"

/**
 * The memories, in two groups: the ones every assistant reads (shared), and
 * the ones one assistant keeps for itself. Each row shows who wrote it and
 * whether it is read in every conversation; Edit opens the whole memory.
 */
export function MemoriesManager({ memories }: { memories: MemorySummary[] }) {
  const shared = memories.filter((memory) => memory.visibility === "shared")
  const kept = memories.filter((memory) => memory.visibility === "private")

  return (
    <>
      <ListSection
        title={`Shared with all your assistants (${shared.length})`}
        description="Every assistant whose token can keep memories reads these, at /memories/shared/. You wrote them, or agreed when an assistant asked to share them."
      >
        <MemoryList
          memories={shared}
          empty="Nothing shared yet. Add a memory, or agree when an assistant asks to share one."
        />
      </ListSection>
      <ListSection
        title={`Kept by one assistant (${kept.length})`}
        description="Only the assistant that wrote one reads it, at /memories/. It needs nobody's say to write them, so look here now and then."
      >
        <MemoryList
          memories={kept}
          empty="No assistant has kept a memory yet."
        />
      </ListSection>
    </>
  )
}

function MemoryList({
  memories,
  empty,
}: {
  memories: MemorySummary[]
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
        <MemoryRow key={memory.id} memory={memory} />
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

function MemoryRow({ memory }: { memory: MemorySummary }) {
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
