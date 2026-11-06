"use client"

import {
  useActionState,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type FormEvent,
  type RefObject,
} from "react"

import Link from "next/link"
import {
  Download,
  ExternalLink,
  Eye,
  File,
  FileImage,
  FileText,
  Film,
  Folder,
  Link2,
  Music,
  type LucideIcon,
} from "lucide-react"

import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { Button, buttonVariants } from "@kaperkunde/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@kaperkunde/ui/dialog"
import { Input } from "@kaperkunde/ui/input"
import { List, ListSection } from "@kaperkunde/ui/list"
import {
  deleteEntryAction,
  makeFolderAction,
  moveEntryAction,
  uploadFilesAction,
  type FileActionResult,
} from "@/lib/actions/storage"
import type { StorePreview } from "@/lib/core/storage/browse"
import type { Entry } from "@/lib/core/storage/files"
import { cn } from "@/lib/utils"

/** An entry as the page hands it in: how a file is previewed, if it is. */
export type BrowserEntry = Entry & { preview: StorePreview | null }

/** Bounds the page sets (lib/core/storage/browse.ts). */
export type BrowserLimits = {
  /** The most one upload sends at once. */
  uploadBytes: number
  /** The start of a text file a preview shows. */
  textPreviewBytes: number
  /** The most "Show all" reads. */
  textShowAllBytes: number
}

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

const ICONS: Record<StorePreview, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  text: FileText,
  audio: Music,
  video: Film,
}

/** The store's file route: a download, or with `inline` a preview. */
function fileUrl(storeId: string, path: string, inline = false): string {
  const query = new URLSearchParams({ path })
  if (inline) query.set("inline", "1")
  return `/api/storage/${encodeURIComponent(storeId)}/download?${query}`
}

/**
 * The folder the file browser shows: its entries, folders first, each file
 * with a preview where PCP shows its kind, download, rename and delete;
 * then upload (files picked or dropped anywhere on the browser) and a new
 * folder, both left out of a read-only store.
 */
export function StorageBrowser({
  storeId,
  path,
  entries,
  truncated,
  readOnly,
  limits,
}: {
  storeId: string
  path: string
  entries: BrowserEntry[]
  truncated: boolean
  readOnly: boolean
  limits: BrowserLimits
}) {
  const uploadRef = useRef<UploadHandle | null>(null)
  const [dragging, setDragging] = useState(false)
  const [previewing, setPreviewing] = useState<BrowserEntry | null>(null)

  const dropProps = readOnly
    ? {}
    : {
        onDragOver(event: DragEvent) {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
          setDragging(true)
        },
        onDragLeave(event: DragEvent) {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setDragging(false)
          }
        },
        onDrop(event: DragEvent) {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          setDragging(false)
          uploadRef.current?.send(event.dataTransfer.files)
        },
      }

  return (
    <div
      className={cn(
        "-m-2 flex flex-col gap-8 rounded-2xl p-2 transition-shadow",
        dragging && "ring-2 ring-primary",
      )}
      data-testid="storage-browser"
      {...dropProps}
    >
      <ListSection
        title={path ? path.split("/").at(-1) : "Top of the store"}
        description={
          readOnly
            ? undefined
            : "Drop files here to upload them to this folder."
        }
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
                storeId={storeId}
                entry={entry}
                readOnly={readOnly}
                onPreview={() => setPreviewing(entry)}
              />
            ))
          )}
        </List>
      </ListSection>
      {readOnly ? null : (
        <ChangeForms
          storeId={storeId}
          path={path}
          uploadBytes={limits.uploadBytes}
          uploadRef={uploadRef}
        />
      )}
      <PreviewDialog
        storeId={storeId}
        entry={previewing}
        limits={limits}
        onClose={() => setPreviewing(null)}
      />
    </div>
  )
}

function EntryRow({
  storeId,
  entry,
  readOnly,
  onPreview,
}: {
  storeId: string
  entry: BrowserEntry
  readOnly: boolean
  onPreview: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<FileActionResult>({ status: "idle" })
  const [moveState, move] = useActionState<FileActionResult, FormData>(
    moveEntryAction.bind(null, storeId, entry.path),
    { status: "idle" },
  )
  const Icon =
    entry.type === "folder"
      ? Folder
      : entry.type === "link"
        ? Link2
        : entry.preview
          ? ICONS[entry.preview]
          : File
  const query = new URLSearchParams({ path: entry.path })

  return (
    <li className={rowClassName}>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        {entry.type === "folder" ? (
          <Link
            href={`/files/${storeId}?${query}`}
            className="truncate text-[15px] text-foreground hover:underline"
          >
            {entry.name}
          </Link>
        ) : entry.preview ? (
          <button
            type="button"
            onClick={onPreview}
            className="cursor-pointer truncate text-left text-[15px] text-foreground hover:underline"
          >
            {entry.name}
          </button>
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
      {entry.type === "file" && entry.preview ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onPreview}
          aria-label={`Preview ${entry.name}`}
        >
          <Eye aria-hidden />
          Preview
        </Button>
      ) : null}
      {entry.type === "file" ? (
        <a
          href={fileUrl(storeId, entry.path)}
          download={entry.name}
          className="text-sm text-primary hover:underline"
          aria-label={`Download ${entry.name}`}
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
                setResult(await deleteEntryAction(storeId, entry.path, folder))
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

/** What the browser's drop target hands the upload form. */
type UploadHandle = { send(files: FileList): void }

function ChangeForms({
  storeId,
  path,
  uploadBytes,
  uploadRef,
}: {
  storeId: string
  path: string
  uploadBytes: number
  uploadRef: RefObject<UploadHandle | null>
}) {
  const [uploadState, upload] = useActionState<FileActionResult, FormData>(
    uploadFilesAction.bind(null, storeId, path),
    { status: "idle" },
  )
  const [folderState, makeFolder] = useActionState<FileActionResult, FormData>(
    makeFolderAction.bind(null, storeId, path),
    { status: "idle" },
  )
  const [tooLarge, setTooLarge] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /** Files over what the page sends at once are refused before they go. */
  function check(files: FileList | null): boolean {
    const total = [...(files ?? [])].reduce((sum, file) => sum + file.size, 0)

    if (total > uploadBytes) {
      setTooLarge(
        `That is more than the ${SIZE.format(uploadBytes)} the page uploads at once: upload fewer files at a time, or have an assistant save a larger one.`,
      )
      return false
    }

    setTooLarge(null)
    return true
  }

  useImperativeHandle(uploadRef, () => ({
    send(files) {
      const input = inputRef.current

      if (!input || files.length === 0) return
      input.files = files
      if (check(files)) formRef.current?.requestSubmit()
    },
  }))

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (!check(inputRef.current?.files ?? null)) event.preventDefault()
  }

  return (
    <ListSection title="Add here">
      <List>
        <form
          ref={formRef}
          action={upload}
          onSubmit={onSubmit}
          className={rowClassName}
        >
          <span className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
            <Input
              ref={inputRef}
              type="file"
              name="files"
              multiple
              required
              aria-label="Files to upload"
              onChange={(event) => check(event.currentTarget.files)}
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" name="overwrite" />
              Replace a file of the same name
            </label>
            <FormError
              error={
                tooLarge ??
                (uploadState.status === "error" ? uploadState.error : null)
              }
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

/**
 * A file shown over the page: an image, a sound or a video in the page, a
 * text file's start as plain text (the rest on demand), a PDF in the
 * browser's own viewer in a tab of its own (PCP's pages are never framed).
 * Served by the store's file route, which checks the file's bytes first.
 */
function PreviewDialog({
  storeId,
  entry,
  limits,
  onClose,
}: {
  storeId: string
  entry: BrowserEntry | null
  limits: BrowserLimits
  onClose: () => void
}) {
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {entry ? (
        <DialogContent className="max-w-[880px]" data-testid="file-preview">
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl break-words">
              {entry.name}
            </DialogTitle>
            <DialogDescription>
              {[
                entry.size !== undefined ? SIZE.format(entry.size) : null,
                WHEN.format(new Date(entry.modified)),
              ]
                .filter(Boolean)
                .join(" · ")}
            </DialogDescription>
          </div>
          <PreviewBody storeId={storeId} entry={entry} limits={limits} />
          <DialogFooter>
            <a
              href={fileUrl(storeId, entry.path)}
              download={entry.name}
              className={buttonVariants({ variant: "secondary" })}
            >
              <Download aria-hidden />
              Download
            </a>
            <DialogClose className={buttonVariants()}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

function PreviewBody({
  storeId,
  entry,
  limits,
}: {
  storeId: string
  entry: BrowserEntry
  limits: BrowserLimits
}) {
  const url = fileUrl(storeId, entry.path, true)
  const media = "max-h-[60vh] w-full rounded-lg bg-background"

  switch (entry.preview) {
    case "image":
      return <ImagePreview url={url} name={entry.name} className={media} />
    case "audio":
      return (
        <audio controls preload="metadata" src={url} className="w-full">
          Your browser does not play this sound: download it instead.
        </audio>
      )
    case "video":
      return (
        <video controls preload="metadata" src={url} className={media}>
          Your browser does not play this video: download it instead.
        </video>
      )
    case "pdf":
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener"
          className={cn(buttonVariants({ variant: "secondary" }), "self-start")}
        >
          <ExternalLink aria-hidden />
          Open the PDF in a new tab
        </a>
      )
    case "text":
      return (
        <TextPreview
          key={entry.path}
          url={url}
          size={entry.size ?? 0}
          limits={limits}
        />
      )
    default:
      return null
  }
}

/**
 * An image as the route serves it; one whose bytes are not the image its
 * name says goes only as a download, and the page says so.
 */
function ImagePreview({
  url,
  name,
  className,
}: {
  url: string
  name: string
  className: string
}) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <p className="text-muted-foreground">
        PCP shows this file only as a download: its content is not an image it
        shows in the page.
      </p>
    )
  }

  return (
    // A store's file, served by PCP's own route: next/image has nothing to
    // optimise here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={`Preview of ${name}`}
      className={cn(className, "object-contain")}
      onError={() => setFailed(true)}
    />
  )
}

type TextState =
  | { bytes: number; state: "error"; message: string }
  | { bytes: number; state: "shown"; text: string }

/** The first `bytes` of a text file, through the store's file route. */
async function readText(url: string, bytes: number): Promise<TextState> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Range: `bytes=0-${bytes - 1}` },
    })

    if (!response.ok) {
      return {
        bytes,
        state: "error",
        message:
          (await response.text().catch(() => "")) ||
          "That file could not be read.",
      }
    }

    return {
      bytes,
      state: "shown",
      text: new TextDecoder("utf-8").decode(await response.arrayBuffer()),
    }
  } catch {
    return { bytes, state: "error", message: "That file could not be read." }
  }
}

/** A text file's start, then all of it on demand, up to a bound. */
function TextPreview({
  url,
  size,
  limits,
}: {
  url: string
  size: number
  limits: BrowserLimits
}) {
  const [bytes, setBytes] = useState(limits.textPreviewBytes)
  const [shown, setShown] = useState<TextState | null>(null)

  useEffect(() => {
    let live = true

    void readText(url, bytes).then((read) => {
      if (live) setShown(read)
    })

    return () => {
      live = false
    }
  }, [url, bytes])

  if (!shown || shown.bytes !== bytes) {
    return <p className="text-muted-foreground">Reading…</p>
  }

  if (shown.state === "error") {
    return (
      <p className="text-destructive" role="alert">
        {shown.message}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <pre
        className="max-h-[60vh] overflow-auto rounded-lg bg-background p-3 font-mono text-xs break-all whitespace-break-spaces"
        data-testid="file-preview-text"
      >
        {shown.text}
      </pre>
      {size <= bytes ? null : size <= limits.textShowAllBytes ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setBytes(limits.textShowAllBytes)}
        >
          Show all
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          This is the start of the file: download it to read the rest.
        </p>
      )}
    </div>
  )
}
