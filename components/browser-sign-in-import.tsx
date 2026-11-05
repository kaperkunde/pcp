"use client"

import { useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import { Disclosure } from "@/components/ui/disclosure"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  importSignInsAction,
  previewSignInImportAction,
} from "@/lib/actions/browser"
import { MAX_SIGN_IN_IMPORT_BYTES } from "@/lib/core/constants"
import type { ImportPreview } from "@/lib/core/browser/sign-in-import"

/** The most sites the preview names one by one. */
const SHOWN_SITES = 30

const FORMAT_NAMES: Record<ImportPreview["format"], string> = {
  "storage-state": "Playwright storage state",
  "cookie-json": "a JSON list of cookies",
  "cookies-txt": "a cookies.txt file",
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

/**
 * The Sign-ins section's import: a sign-in made in another browser, pasted
 * or chosen as a file, previewed (sites and counts, what is left out and
 * replaced) and imported only as previewed. The text stays in this page
 * until then; PCP reads it for the preview and again for the import.
 */
export function BrowserSignInImport({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("")
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function change(next: string) {
    setText(next)
    setPreview(null)
    setDone(null)
    setError(null)
  }

  async function choose(file: File | undefined) {
    if (!file) return
    if (file.size > MAX_SIGN_IN_IMPORT_BYTES) {
      setError(
        `The file is over ${MAX_SIGN_IN_IMPORT_BYTES / 1024 / 1024} MB, more than the browser keeps.`,
      )
      return
    }
    change(await file.text())
  }

  function showPreview() {
    startTransition(async () => {
      const result = await previewSignInImportAction(text)
      setPreview(result.status === "ok" ? result.preview : null)
      setError(result.status === "error" ? result.error : null)
    })
  }

  function confirm() {
    if (!preview) return
    startTransition(async () => {
      const result = await importSignInsAction(text, preview.basis)

      if (result.status === "ok") {
        setText("")
        setPreview(null)
        setError(null)
        setDone(
          `Imported ${plural(result.cookies, "cookie", "cookies")} for ${plural(result.sites, "site", "sites")}.`,
        )
        onDone()
      } else if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  return (
    <Disclosure
      inList
      title="Import a sign-in"
      description="From another browser where you are signed in: a cookie export or Playwright's storage state."
    >
      <Field
        label="Cookie export"
        htmlFor="browser-import-text"
        hint="Paste it, or choose its file: cookies.txt, the JSON a cookie extension such as Cookie-Editor saves, or Playwright's storage state. It holds your sign-ins as they are, so delete the file once it is imported. PCP's own site is left out."
      >
        <Textarea
          id="browser-import-text"
          value={text}
          onChange={(event) => change(event.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          className="font-mono text-xs md:text-xs"
          placeholder='[{"domain": ".example.com", "name": "session", …}]'
        />
        <Input
          type="file"
          aria-label="Choose a cookie export"
          accept=".txt,.json,text/plain,application/json"
          className="py-2"
          onChange={(event) => {
            void choose(event.target.files?.[0])
            event.target.value = ""
          }}
        />
      </Field>

      {preview ? (
        <ImportPreviewList preview={preview} />
      ) : (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !text.trim()}
            onClick={showPreview}
          >
            {pending ? "Reading…" : "Preview"}
          </Button>
        </div>
      )}

      {preview ? (
        <div className="flex gap-2">
          <Button type="button" disabled={pending} onClick={confirm}>
            {pending ? "Importing…" : "Import"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setPreview(null)}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <FormError error={error} />
      <FormNote message={done} />
    </Disclosure>
  )
}

function ImportPreviewList({ preview }: { preview: ImportPreview }) {
  const shown = preview.sites.slice(0, SHOWN_SITES)
  const more = preview.sites.length - shown.length

  return (
    <div
      className="flex flex-col gap-2 text-sm"
      data-testid="browser-import-preview"
    >
      <p>
        {FORMAT_NAMES[preview.format]}:{" "}
        {plural(preview.cookies, "cookie", "cookies")}
        {preview.origins
          ? ` and local storage for ${plural(preview.origins, "site", "sites")}`
          : ""}
        , for:
      </p>
      <ul className="flex flex-col gap-0.5 font-mono text-xs">
        {shown.map((site) => (
          <li key={site.site}>
            {site.site}{" "}
            <span className="text-muted-foreground">
              {[
                site.cookies ? plural(site.cookies, "cookie", "cookies") : "",
                site.storage ? "local storage" : "",
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
          </li>
        ))}
        {more > 0 ? (
          <li className="text-muted-foreground">
            and {plural(more, "more", "more")}
          </li>
        ) : null}
      </ul>
      {preview.skipped.length ? (
        <p className="text-muted-foreground">
          Left out:{" "}
          {preview.skipped
            .map((skip) => `${skip.count.toLocaleString()} ${skip.label}`)
            .join("; ")}
          .
        </p>
      ) : null}
      <p className="text-muted-foreground">
        {preview.replaces.sites
          ? `It replaces what the browser keeps for ${plural(preview.replaces.sites, "site", "sites")} (${plural(preview.replaces.cookies, "cookie", "cookies")}); every other site stays as it is.`
          : "The browser keeps nothing for these sites yet; every other site stays as it is."}{" "}
        {preview.browserOpen
          ? "The browser closes to import it, with its tabs."
          : ""}{" "}
        Where an assistant may open these sites, it acts as you there.
      </p>
    </div>
  )
}
