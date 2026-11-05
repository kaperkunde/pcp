"use client"

import { useActionState, useState, useTransition } from "react"

import Link from "next/link"
import { File, Folder, Link2 } from "lucide-react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { List, ListSection } from "@/components/ui/list"
import {
  deleteEntryAction,
  makeFolderAction,
  moveEntryAction,
  uploadFilesAction,
  type FileActionResult,
} from "@/lib/actions/storage"
import type { Entry } from "@/lib/core/storage/files"

const rowClassName =
  "flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2.5 text-sm"

const SIZE = new Intl.NumberFormat("en", {
  notation: "compact",
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
})

const WHEN = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
})

/**
 * The folder the file browser shows: its entries, each with download,
 * rename and delete, then upload and a new folder (both left out of a
 * read-only folder).
 */
export function StorageBrowser({
  serverId,
  path,
  entries,
  truncated,
  readOnly,
}: {
  serverId: string
  path: string
  entries: Entry[]
  truncated: boolean
  readOnly: boolean
}) {
  return (
    <>
      <ListSection
        title={path ? path.split("/").at(-1) : "Top of the folder"}
        footer={
          truncated
            ? "This folder holds more than PCP lists at once: these are the first."
            : undefined
        }
        data-testid="storage-entries"
      >
        <List as="ul">
          {entries.length === 0 ? (
            <li className={`${rowClassName} text-muted-foreground`}>
              Nothing here yet.
            </li>
          ) : (
            entries.map((entry) => (
              <EntryRow
                key={entry.name}
                serverId={serverId}
                entry={entry}
                readOnly={readOnly}
              />
            ))
          )}
        </List>
      </ListSection>
      {readOnly ? null : <ChangeForms serverId={serverId} path={path} />}
    </>
  )
}

function EntryRow({
  serverId,
  entry,
  readOnly,
}: {
  serverId: string
  entry: Entry
  readOnly: boolean
}) {
  const [renaming, setRenaming] = useState(false)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<FileActionResult>({ status: "idle" })
  const [moveState, move] = useActionState<FileActionResult, FormData>(
    moveEntryAction.bind(null, serverId, entry.path),
    { status: "idle" },
  )
  const Icon =
    entry.type === "folder" ? Folder : entry.type === "link" ? Link2 : File
  const query = new URLSearchParams({ path: entry.path })

  return (
    <li className={rowClassName}>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        {entry.type === "folder" ? (
          <Link
            href={`/servers/${serverId}/files?${query}`}
            className="truncate text-[15px] text-foreground hover:underline"
          >
            {entry.name}
          </Link>
        ) : (
          <span className="truncate text-[15px]">{entry.name}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {entry.type === "link"
            ? entry.points === "inside"
              ? "A link inside the folder"
              : entry.points === "outside"
                ? "A link out of the folder: PCP does not follow it"
                : "A link to nothing"
            : [
                entry.size !== undefined ? SIZE.format(entry.size) : null,
                WHEN.format(new Date(entry.modified)),
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        {renaming ? (
          <form action={move} className="mt-2 flex flex-wrap gap-2">
            <Input
              name="to"
              defaultValue={entry.path}
              aria-label={`New path for ${entry.name}`}
              className="min-w-0 flex-1 basis-48 font-mono"
              required
            />
            <SubmitButton size="sm" pendingText="Moving…">
              Move
            </SubmitButton>
            <Button
              type="button"
              variant="plain"
              size="sm"
              onClick={() => setRenaming(false)}
            >
              Cancel
            </Button>
          </form>
        ) : null}
        <FormError
          error={
            moveState.status === "error"
              ? moveState.error
              : result.status === "error"
                ? result.error
                : null
          }
        />
      </span>
      {entry.type === "file" ? (
        <a
          href={`/api/storage/${serverId}/download?${query}`}
          download={entry.name}
          className="text-sm text-primary hover:underline"
        >
          Download
        </a>
      ) : null}
      {readOnly || renaming ? null : (
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => setRenaming(true)}
          >
            Rename
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => {
              const folder = entry.type === "folder"

              if (
                !window.confirm(
                  folder
                    ? `Delete the folder ${entry.name} and everything in it, for good? There is no Trash.`
                    : `Delete ${entry.name} for good? There is no Trash.`,
                )
              ) {
                return
              }

              startTransition(async () => {
                setResult(await deleteEntryAction(serverId, entry.path, folder))
              })
            }}
          >
            Delete
          </Button>
        </>
      )}
    </li>
  )
}

function ChangeForms({ serverId, path }: { serverId: string; path: string }) {
  const [uploadState, upload] = useActionState<FileActionResult, FormData>(
    uploadFilesAction.bind(null, serverId, path),
    { status: "idle" },
  )
  const [folderState, makeFolder] = useActionState<FileActionResult, FormData>(
    makeFolderAction.bind(null, serverId, path),
    { status: "idle" },
  )

  return (
    <ListSection title="Add here">
      <List>
        <form action={upload} className={rowClassName}>
          <span className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
            <Input
              type="file"
              name="files"
              multiple
              required
              aria-label="Files to upload"
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" name="overwrite" />
              Replace a file of the same name
            </label>
            <FormError
              error={uploadState.status === "error" ? uploadState.error : null}
            />
            <FormNote
              message={uploadState.status === "ok" ? uploadState.message : null}
            />
          </span>
          <SubmitButton size="sm" variant="secondary" pendingText="Uploading…">
            Upload
          </SubmitButton>
        </form>
        <form action={makeFolder} className={rowClassName}>
          <span className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
            <Input
              name="name"
              required
              placeholder="New folder"
              aria-label="New folder's name"
            />
            <FormError
              error={folderState.status === "error" ? folderState.error : null}
            />
          </span>
          <SubmitButton size="sm" variant="secondary" pendingText="Making…">
            New folder
          </SubmitButton>
        </form>
      </List>
    </ListSection>
  )
}
