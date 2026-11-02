"use client"

import { Check, CircleAlert, FileUp, LoaderCircle } from "lucide-react"
import { useEffect, useId, useState } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import { List, ListRow, ListSection, RowValue } from "@/components/ui/list"
import { cn } from "@/lib/utils"

type Item = {
  key: string
  name: string
  size: number
  state: "waiting" | "sending" | "sent" | "failed"
  progress: number
  message?: string
}

type Sent =
  | { ok: true; open: boolean; remaining: number; until: string | null }
  | { ok: false; status: number; message: string }

const NO_CONNECTION =
  "It could not be sent. Check the connection and choose it again."

/** One file, as the PUT body of its own request, with its progress. */
function sendFile(
  secret: string,
  file: File,
  onProgress: (share: number) => void,
): Promise<Sent> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest()

    request.open("PUT", `/api/files/${encodeURIComponent(secret)}`)
    // A header carries Latin-1 only: the name goes percent-encoded.
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name))

    if (!file.type) {
      request.setRequestHeader("Content-Type", "application/octet-stream")
    }

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total)
      }
    }
    request.onload = () => {
      let body: Record<string, unknown> = {}

      try {
        body = JSON.parse(request.responseText) as Record<string, unknown>
      } catch {
        // Not JSON: the status says enough.
      }

      resolve(
        request.status === 201
          ? {
              ok: true,
              open: body.open === true,
              remaining:
                typeof body.remaining === "number" ? body.remaining : 0,
              until: typeof body.until === "string" ? body.until : null,
            }
          : {
              ok: false,
              status: request.status,
              message:
                typeof body.error === "string" ? body.error : NO_CONNECTION,
            },
      )
    }
    request.onerror = () =>
      resolve({ ok: false, status: 0, message: NO_CONNECTION })
    request.send(file)
  })
}

/** A time of day in the reader's own zone, written after hydration. */
function LocalTime({ value }: { value: string }) {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    setText(
      new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    )
  }, [value])

  return (
    <time dateTime={value} suppressHydrationWarning>
      {text ?? `${value.slice(11, 16)} UTC`}
    </time>
  )
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The upload page's form: a file picker (a phone offers the camera, a scan
 * or its files), each file sent as it is chosen, one after another, with
 * its progress, and Done once something arrived.
 */
export function UploadFiles({
  secret,
  open: initiallyOpen,
  remaining: initiallyRemaining,
  maxFiles,
  until: initialUntil,
  received,
}: {
  secret: string
  open: boolean
  remaining: number
  maxFiles: number
  until: string
  received: { name: string | null; size: number }[]
}) {
  const inputId = useId()
  const [open, setOpen] = useState(initiallyOpen)
  const [remaining, setRemaining] = useState(initiallyRemaining)
  const [until, setUntil] = useState(initialUntil)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [doneError, setDoneError] = useState<string | null>(null)

  const sentCount =
    received.length + items.filter((item) => item.state === "sent").length

  function update(key: string, change: Partial<Item>) {
    setItems((all) =>
      all.map((item) => (item.key === key ? { ...item, ...change } : item)),
    )
  }

  async function choose(files: File[]) {
    if (files.length === 0) {
      return
    }

    const stamp = Date.now()
    const queued: Item[] = files.map((file, index) => ({
      key: `${stamp}-${index}`,
      name: file.name || "file",
      size: file.size,
      state: index < remaining ? "waiting" : "failed",
      progress: 0,
      ...(index < remaining
        ? {}
        : {
            message: `Not sent: this link takes ${maxFiles} file${maxFiles === 1 ? "" : "s"}.`,
          }),
    }))

    setItems((all) => [...all, ...queued])
    setBusy(true)

    let left = remaining
    let stillOpen = true

    for (const [index, file] of files.entries()) {
      const item = queued[index]

      if (item.state !== "waiting") {
        continue
      }

      if (!stillOpen || left === 0) {
        update(item.key, {
          state: "failed",
          message: "Not sent: the link no longer takes files.",
        })
        continue
      }

      update(item.key, { state: "sending" })
      const sent = await sendFile(secret, file, (progress) =>
        update(item.key, { progress }),
      )

      if (sent.ok) {
        update(item.key, { state: "sent", progress: 1 })
        left = sent.remaining
        stillOpen = sent.open

        if (sent.until) {
          setUntil(sent.until)
        }
      } else {
        update(item.key, { state: "failed", message: sent.message })

        // Gone, closed or full: nothing more will go.
        if ([404, 409, 410].includes(sent.status)) {
          stillOpen = false
          left = 0
        }
      }
    }

    setRemaining(left)
    setOpen(stillOpen && left > 0)
    setBusy(false)
  }

  async function finish() {
    setDoneError(null)

    try {
      const response = await fetch(`/api/files/${encodeURIComponent(secret)}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: unknown
        }
        setDoneError(
          typeof body.error === "string" ? body.error : NO_CONNECTION,
        )
        return
      }

      setDone(true)
      setOpen(false)
    } catch {
      setDoneError(NO_CONNECTION)
    }
  }

  const closedLine = done
    ? `Done. Tell the assistant you have uploaded ${sentCount === 1 ? "the file" : "the files"}; you can close this page.`
    : sentCount > 0
      ? "All set: this link takes no more files. Tell the assistant you have uploaded them; you can close this page."
      : "This link no longer takes files. Ask the assistant for a new one."

  return (
    <div className="flex flex-col gap-6">
      {received.length > 0 || items.length > 0 ? (
        <ListSection title="Files">
          <List as="ul" aria-label="Files">
            {received.map((file, index) => (
              <ListRow
                as="li"
                key={`received-${index}`}
                icon={
                  <Check aria-hidden className="size-4 shrink-0 text-primary" />
                }
                title={
                  <span className="break-all">{file.name ?? "A file"}</span>
                }
                description={`Sent · ${sizeOf(file.size)}`}
              />
            ))}
            {items.map((item) => (
              <ListRow
                as="li"
                key={item.key}
                icon={
                  item.state === "sent" ? (
                    <Check
                      aria-hidden
                      className="size-4 shrink-0 text-primary"
                    />
                  ) : item.state === "failed" ? (
                    <CircleAlert
                      aria-hidden
                      className="size-4 shrink-0 text-destructive"
                    />
                  ) : (
                    <LoaderCircle
                      aria-hidden
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground",
                        item.state === "sending" && "animate-spin",
                      )}
                    />
                  )
                }
                title={<span className="break-all">{item.name}</span>}
                description={
                  item.state === "failed" ? (
                    <span className="text-destructive">{item.message}</span>
                  ) : item.state === "sent" ? (
                    `Sent · ${sizeOf(item.size)}`
                  ) : item.state === "sending" ? (
                    `Sending… ${Math.round(item.progress * 100)}% of ${sizeOf(item.size)}`
                  ) : (
                    `Waiting · ${sizeOf(item.size)}`
                  )
                }
                trailing={
                  item.state === "sending" ? (
                    <RowValue>
                      <progress
                        className="h-1.5 w-20 accent-primary"
                        max={1}
                        value={item.progress}
                        aria-label={`Sending ${item.name}`}
                      />
                    </RowValue>
                  ) : undefined
                }
              />
            ))}
          </List>
        </ListSection>
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-3">
        {open ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <input
                id={inputId}
                type="file"
                multiple
                className="peer sr-only"
                disabled={busy}
                onChange={(event) => {
                  const input = event.currentTarget
                  // Copied before the input is cleared, so the same file
                  // can be chosen again.
                  const list = Array.from(input.files ?? [])
                  input.value = ""
                  void choose(list)
                }}
              />
              <label
                htmlFor={inputId}
                aria-disabled={busy}
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                  busy && "pointer-events-none opacity-50",
                )}
              >
                <FileUp aria-hidden />
                {sentCount > 0 ? "Choose more files" : "Choose files"}
              </label>
              {sentCount > 0 ? (
                <Button
                  variant="secondary"
                  size="lg"
                  disabled={busy}
                  onClick={() => void finish()}
                >
                  Done
                </Button>
              ) : null}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Take a photo, scan a document or pick files: up to {remaining}{" "}
              more, until <LocalTime value={until} />. Only the assistant that
              asked gets them, for a day. Whoever has this link can upload to
              it, so keep it to yourself.
            </p>
            {doneError ? (
              <p className="text-sm text-destructive">{doneError}</p>
            ) : null}
          </>
        ) : busy ? null : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {closedLine}
          </p>
        )}
      </div>
    </div>
  )
}
