"use client"

import Link from "next/link"
import { useActionState, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox, Input, Textarea } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import {
  createMemoryAction,
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

export function MemoriesManager({ memories }: { memories: MemorySummary[] }) {
  const shared = memories.filter((memory) => memory.visibility === "shared")
  const kept = memories.filter((memory) => memory.visibility === "private")

  return (
    <div className="flex flex-col gap-6">
      <AddMemoryForm />
      <Card>
        <CardHeader>
          <CardTitle>
            Shared with all your assistants ({shared.length})
          </CardTitle>
          <CardDescription>
            Every assistant whose token can keep memories reads these, at
            /memories/shared/. You wrote them, or agreed when an assistant asked
            to share them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MemoryList
            memories={shared}
            empty="Nothing shared yet. Add a memory above, or agree when an assistant asks to share one."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Kept by one assistant ({kept.length})</CardTitle>
          <CardDescription>
            Only the assistant that wrote one reads it, at /memories/. It needs
            nobody&apos;s say to write them, so look here now and then.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MemoryList
            memories={kept}
            empty="No assistant has kept a memory yet."
          />
        </CardContent>
      </Card>
    </div>
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
    return <p className="text-muted-foreground">{empty}</p>
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {memories.map((memory) => (
        <MemoryRow key={memory.id} memory={memory} />
      ))}
    </ul>
  )
}

function AddMemoryForm() {
  const [state, action] = useActionState<MemoryActionResult, FormData>(
    createMemoryAction,
    { status: "idle" },
  )
  // A fresh key after each success empties the form.
  const formKey = state.status === "ok" ? state.id : "new"

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a shared memory</CardTitle>
        <CardDescription>
          Something every assistant should know about you: how you like to work,
          what you are working on, decisions already made.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form key={formKey} action={action} className="flex flex-col gap-4">
          <Field
            label="Path"
            htmlFor="memory-path"
            hint="Assistants find it at /memories/shared/ followed by this."
          >
            <Input
              id="memory-path"
              name="path"
              required
              maxLength={MAX_MEMORY_PATH}
              placeholder="preferences.md"
            />
          </Field>
          <Field
            label="Text"
            htmlFor="memory-text"
            hint={`Up to ${MAX_SHARED_MEMORY_CHARS.toLocaleString("en")} characters.`}
          >
            <Textarea
              id="memory-text"
              name="text"
              required
              maxLength={MAX_SHARED_MEMORY_CHARS}
              className="min-h-24"
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <div>
            <SubmitButton pendingText="Saving…">Save memory</SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
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
    <li className="flex flex-col gap-2 py-3" data-testid="memory">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="font-medium break-all">{memory.fullPath}</code>
          {memory.visibility === "shared" ? (
            <Badge>Shared</Badge>
          ) : memory.tokenName ? (
            <Badge variant="outline">Only {memory.tokenName}</Badge>
          ) : null}
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "Cancel" : "Edit"}
          </Button>
          <Button variant="ghost" size="xs" disabled={pending} onClick={remove}>
            Delete
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Written by <Writer memory={memory} /> · updated{" "}
        <LocalDate value={memory.updatedAt} />
        {memory.visibility === "private" &&
        memory.author === "owner" &&
        memory.tokenName
          ? ` · kept for ${memory.tokenName}`
          : null}
      </p>
      {editing ? (
        <form
          action={action}
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
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
            hint={`Up to ${MAX_SHARED_MEMORY_CHARS.toLocaleString("en")} characters when shared, ${MAX_MEMORY_CHARS.toLocaleString("en")} otherwise.`}
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
          <div className="flex flex-col gap-1.5">
            <Label className="font-normal" htmlFor={`${id}-shared`}>
              <Checkbox
                id={`${id}-shared`}
                name="shared"
                defaultChecked={memory.visibility === "shared"}
                disabled={!canBePrivate}
              />
              Shared with all your assistants
            </Label>
            {canBePrivate ? null : (
              // A disabled checkbox is not sent; this keeps it shared.
              <input type="hidden" name="shared" value="on" />
            )}
            <p className="text-xs text-muted-foreground">
              {canBePrivate
                ? `Unticked, only ${memory.tokenName ?? "the assistant that wrote it"} reads it.`
                : "No assistant's token is behind this one, so it stays shared."}
            </p>
          </div>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton size="sm" pendingText="Saving…">
              Save
            </SubmitButton>
          </div>
        </form>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-md border border-input bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
          {memory.text}
        </pre>
      )}
      <FormError error={error} />
    </li>
  )
}
