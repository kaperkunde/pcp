"use client"

import {
  Download,
  ExternalLink,
  FileImage,
  FileText,
  File as FileIcon,
  FileX,
  type LucideIcon,
} from "lucide-react"
import { useState } from "react"

import { LocalDate } from "@/components/local-date"
import { Button, buttonVariants } from "@kaperkunde/ui/button"
import type { RequestFile } from "@/lib/core/permission-files"
import { cn } from "@/lib/utils"

/** The first lines of a text file shown before "Show all". */
const FIRST_LINES = 12

/** The most of a text file shown in the page; the rest opens in a tab. */
const MAX_SHOWN_CHARS = 200_000

const ICONS: Record<string, LucideIcon> = {
  pdf: FileText,
  image: FileImage,
  text: FileText,
}

function fileUrl(requestId: string, fileId: string, download = false): string {
  return `/api/permissions/${encodeURIComponent(requestId)}/files/${encodeURIComponent(fileId)}${download ? "?download=1" : ""}`
}

/**
 * The files a waiting call carries (lib/core/permission-files.ts), one chip
 * each: its name, type, size, the tool that kept it and until when, to look
 * at in the page and download before answering. Served only while the
 * request waits (app/api/permissions/[id]/files/[result]/route.ts).
 */
export function PermissionFiles({
  requestId,
  files,
  pending,
}: {
  requestId: string
  files: RequestFile[]
  pending: boolean
}) {
  return (
    <section className="flex flex-col gap-2" data-testid="permission-files">
      <h2 className="text-sm font-medium">
        {files.length === 1
          ? "The file this call sends"
          : `The ${files.length} files this call sends`}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {files.map((file) => (
          <li key={file.id}>
            <FileChip requestId={requestId} file={file} pending={pending} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function FileChip({
  requestId,
  file,
  pending,
}: {
  requestId: string
  file: RequestFile
  pending: boolean
}) {
  if (!file.found) {
    return (
      <div
        className="flex items-start gap-3 rounded-xl bg-field px-4 py-3 ring-1 ring-destructive/30"
        data-testid="permission-file"
      >
        <FileX
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <span className="min-w-0 text-sm break-words">
          <span className="font-medium">{file.id}</span>: no longer kept for
          this token, so the call will fail.
        </span>
      </div>
    )
  }

  const Icon = (file.preview && ICONS[file.preview]) || FileIcon

  return (
    <div
      className="flex flex-col gap-3 rounded-xl bg-field px-4 py-3 ring-1 ring-separator"
      data-testid="permission-file"
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium break-words">
            {file.name ?? "(no name)"}
          </span>
          <span className="text-xs break-words text-muted-foreground">
            {file.mediaType} · {file.size} · from {file.from} · kept until{" "}
            <LocalDate value={file.expiresAt} />
          </span>
        </div>
      </div>
      {pending ? <FilePreview requestId={requestId} file={file} /> : null}
    </div>
  )
}

function FilePreview({
  requestId,
  file,
}: {
  requestId: string
  file: Extract<RequestFile, { found: true }>
}) {
  const url = fileUrl(requestId, file.id)
  const name = file.name ?? "file"

  return (
    <div className="flex flex-col gap-3">
      {file.preview === "image" ? (
        <a href={url} target="_blank" rel="noopener" className="self-start">
          {/* A kept file, served by PCP's own route: next/image has
              nothing to optimise here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={`Preview of ${name}`}
            className="max-h-48 max-w-full rounded-lg bg-background object-contain ring-1 ring-separator"
          />
        </a>
      ) : null}
      {file.preview === "text" ? <TextPreview url={url} /> : null}
      <div className="flex flex-wrap gap-2">
        {file.preview === "pdf" || file.preview === "image" ? (
          <a
            href={url}
            target="_blank"
            rel="noopener"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <ExternalLink aria-hidden />
            Open
          </a>
        ) : null}
        <a
          href={fileUrl(requestId, file.id, true)}
          download={name}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <Download aria-hidden />
          Download
        </a>
      </div>
    </div>
  )
}

type TextState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "shown"; text: string; all: boolean }

/** A text file's first lines, read when asked for, with the rest on demand. */
function TextPreview({ url }: { url: string }) {
  const [shown, setShown] = useState<TextState>({ state: "idle" })

  async function load() {
    setShown({ state: "loading" })

    try {
      const response = await fetch(url, { cache: "no-store" })

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string
        } | null

        setShown({
          state: "error",
          message: body?.error ?? "That file could not be read.",
        })
        return
      }

      setShown({ state: "shown", text: await response.text(), all: false })
    } catch {
      setShown({ state: "error", message: "That file could not be read." })
    }
  }

  if (shown.state === "idle" || shown.state === "loading") {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={shown.state === "loading"}
        onClick={load}
      >
        <FileText aria-hidden />
        {shown.state === "loading" ? "Reading…" : "Show the text"}
      </Button>
    )
  }

  if (shown.state === "error") {
    return (
      <p className="text-sm text-destructive" role="alert">
        {shown.message}
      </p>
    )
  }

  const lines = shown.text.split("\n")
  const cut = !shown.all && lines.length > FIRST_LINES
  const text = cut ? lines.slice(0, FIRST_LINES).join("\n") : shown.text
  const tooLong = text.length > MAX_SHOWN_CHARS

  return (
    <div className="flex flex-col gap-2">
      <pre
        className={cn(
          "max-h-96 overflow-auto rounded-lg bg-background p-3 text-xs break-all whitespace-break-spaces",
        )}
        data-testid="permission-file-text"
      >
        {tooLong ? `${text.slice(0, MAX_SHOWN_CHARS)}…` : text}
      </pre>
      {cut ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShown({ ...shown, all: true })}
        >
          Show all {lines.length.toLocaleString("en-US")} lines
        </Button>
      ) : tooLong ? (
        <a
          href={url}
          target="_blank"
          rel="noopener"
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "self-start",
          )}
        >
          Open it whole
        </a>
      ) : null}
    </div>
  )
}
