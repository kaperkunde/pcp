"use client"

import Link from "next/link"
import {
  startTransition,
  useActionState,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { OwnerConfirmFields } from "@/components/owner-confirm-fields"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox, Input } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import {
  restoreAction,
  restoreAtSetupAction,
  type RestoreResult,
} from "@/lib/actions/backup"
import type { ExportPreview } from "@/lib/core/backup-format"
import {
  EXPORT_FILE_ACCEPT,
  EXPORT_FILE_SUFFIX,
  MAX_EXPORT_FILE_BYTES,
  MIN_PASSWORD_LENGTH,
} from "@/lib/core/constants"

const MAX_FILE_MB = MAX_EXPORT_FILE_BYTES / 1024 / 1024

// ---------------------------------------------------------------------------
// Export

/**
 * Two forms, as for a new token: the one with the owner's password holds the
 * account and the password and nothing else a password manager would fill,
 * or Safari takes it for a sign-up. The export password is chosen first and
 * carried over hidden.
 */
export function ExportCard({ username }: { username: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  function choose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get("exportPassword") ?? "")

    if (password !== String(form.get("exportPasswordConfirm") ?? "")) {
      setMismatch("The export passwords do not match.")
      return
    }

    setMismatch(null)
    setError(null)
    setNote(null)
    setDraft(password)
  }

  // The download is a route handler (an action cannot send a file); the
  // page fetches it so a refused password shows here instead of replacing
  // the page with an error.
  async function download(formData: FormData) {
    setError(null)

    let response: Response

    try {
      response = await fetch("/api/export", { method: "POST", body: formData })
    } catch {
      setError("PCP could not be reached.")
      return
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      setError(body?.error ?? "The export did not work. Check the server log.")
      return
    }

    const name =
      fileNameFrom(response.headers.get("content-disposition")) ??
      `pcp-export${EXPORT_FILE_SUFFIX}`
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    // Not at once: the browser reads the URL as the download starts.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)

    setNote(`Downloaded ${name}. Keep it with your backups.`)
    setDraft(null)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export</CardTitle>
        <CardDescription>
          Everything PCP holds in one file, to keep as a backup or to restore on
          another PCP: servers, API endpoints, mail accounts, secrets, API
          tokens, memories and settings. The file is locked with an export
          password you choose, and the vault inside it stays locked with your
          PCP password, as it is here. Nothing is decrypted to make it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={choose} aria-label="Export">
          <fieldset disabled={draft !== null} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Export password"
                htmlFor="export-password"
                hint={`At least ${MIN_PASSWORD_LENGTH} characters. Not your PCP password: you need it to restore the file, and PCP cannot recover it.`}
              >
                <Input
                  id="export-password"
                  name="exportPassword"
                  type="password"
                  autoComplete="off"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                />
              </Field>
              <Field label="Repeat export password" htmlFor="export-confirm">
                <Input
                  id="export-confirm"
                  name="exportPasswordConfirm"
                  type="password"
                  autoComplete="off"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                />
              </Field>
            </div>
            <FormError error={mismatch} />
            <FormNote message={draft === null ? note : null} />
            {draft === null ? (
              <div>
                <Button type="submit">Continue</Button>
              </div>
            ) : null}
          </fieldset>
        </form>
        {draft !== null ? (
          <form
            action={download}
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
          >
            <p className="text-muted-foreground">
              An export is a lasting copy of your vault, so PCP asks for your
              password before it makes one.
            </p>
            <input type="hidden" name="exportPassword" value={draft} />
            <input type="hidden" name="exportPasswordConfirm" value={draft} />
            <OwnerConfirmFields
              idPrefix="export-owner"
              username={username}
              error={error}
              autoFocus
            />
            <FormError error={error} />
            <div className="flex gap-2">
              <SubmitButton pendingText="Exporting…">Confirm</SubmitButton>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDraft(null)}
              >
                Back
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}

function fileNameFrom(disposition: string | null): string | null {
  const match = disposition?.match(/filename="([^"]+)"/)
  return match?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Restore

/**
 * Two steps through one action: the file and its export password open it
 * and show what it holds; then the owner confirms, and the same file is sent
 * again and written. The file and the password live in state rather than in
 * the form, because React empties a form once its action has run.
 */
export function RestoreCard({
  username,
  mode,
}: {
  username: string
  /** settings: a signed-in owner replaces their vault. setup: a PCP not set up yet. */
  mode: "settings" | "setup"
}) {
  const [state, dispatch, pending] = useActionState<RestoreResult, FormData>(
    mode === "setup" ? restoreAtSetupAction : restoreAction,
    { status: "idle" },
  )
  const [file, setFile] = useState<File | null>(null)
  const [exportPassword, setExportPassword] = useState("")
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  // A result the owner has gone back from: its message is not shown again.
  const [dismissed, setDismissed] = useState<RestoreResult | null>(null)

  useEffect(() => {
    if (state.status === "ok") {
      setPreview(state.preview)
    }
  }, [state])

  const serverError =
    state.status === "error" && state !== dismissed ? state.error : null

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.currentTarget.files?.[0] ?? null)
    setLocalError(null)
  }

  function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!file) {
      setLocalError("Choose an export file.")
      return
    }

    if (file.size > MAX_EXPORT_FILE_BYTES) {
      setLocalError(`That file is larger than ${MAX_FILE_MB} MB.`)
      return
    }

    setLocalError(null)
    const data = new FormData()
    data.set("file", file)
    data.set("exportPassword", exportPassword)
    // Not from a <form action>, so React is told it is an action's work.
    startTransition(() => dispatch(data))
  }

  function restore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!file) {
      return
    }

    const data = new FormData(event.currentTarget)
    data.set("file", file)
    data.set("exportPassword", exportPassword)
    data.set("confirm", "on")
    // Not from a <form action>, so React is told it is an action's work.
    startTransition(() => dispatch(data))
  }

  function back() {
    setDismissed(state)
    setPreview(null)
    setFile(null)
    setExportPassword("")
    setLocalError(null)
  }

  const inSettings = mode === "settings"

  return (
    <Card>
      <CardHeader>
        <CardTitle>{inSettings ? "Restore" : "Restore an export"}</CardTitle>
        <CardDescription>
          {inSettings
            ? "Puts an export in place of everything in this PCP. You see what the file holds before anything changes."
            : "Everything the export holds becomes this PCP's: its servers, secrets, API tokens, memories and settings. You see what the file holds before anything is written."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={check} aria-label="Restore">
          <fieldset disabled={preview !== null} className="flex flex-col gap-4">
            <Field
              label="Export file"
              htmlFor="restore-file"
              hint={`A file PCP exported (${EXPORT_FILE_SUFFIX}), up to ${MAX_FILE_MB} MB.`}
            >
              <Input
                id="restore-file"
                name="file"
                type="file"
                accept={EXPORT_FILE_ACCEPT}
                onChange={chooseFile}
                required
              />
            </Field>
            <Field label="Export password" htmlFor="restore-export-password">
              <Input
                id="restore-export-password"
                name="exportPassword"
                type="password"
                autoComplete="off"
                value={exportPassword}
                onChange={(event) =>
                  setExportPassword(event.currentTarget.value)
                }
                required
              />
            </Field>
            {preview === null ? (
              <>
                <FormError error={localError ?? serverError} />
                <div>
                  <Button type="submit" disabled={pending}>
                    {pending ? "Checking…" : "Check the export"}
                  </Button>
                </div>
              </>
            ) : null}
          </fieldset>
        </form>
        {preview !== null ? (
          <form
            onSubmit={restore}
            aria-label="Confirm the restore"
            className="flex flex-col gap-4 rounded-lg border border-border p-4"
          >
            <PreviewList preview={preview} />
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {inSettings ? (
                <li>
                  Everything in this PCP is replaced: servers, API endpoints,
                  mail accounts, secrets, API tokens, memories and settings.
                  Export this PCP first if you may want it back.
                </li>
              ) : null}
              <li>
                Afterwards you sign in with the password of the PCP the export
                came from, and its recovery key is the one that works.
                {inSettings
                  ? " For this PCP's own export, that is what you have now."
                  : ""}
              </li>
              <li>
                {inSettings
                  ? "API tokens made here stop working; the exported ones work, so assistants set up with them carry on."
                  : "The exported API tokens work here, so assistants set up with them carry on."}
              </li>
            </ul>
            {preview.host ? (
              <Label className="items-start font-normal">
                <Checkbox
                  name="restoreHostSettings"
                  defaultChecked
                  className="mt-0.5"
                />
                <span>
                  Also restore this machine&apos;s settings:{" "}
                  {hostSettingNames(preview.host)}.{" "}
                  <span className="text-muted-foreground">
                    {hostSettingEffects(preview.host)}
                  </span>
                </span>
              </Label>
            ) : null}
            {inSettings ? (
              <>
                <Label className="font-normal">
                  <Checkbox name="replace" required />
                  Replace everything in this PCP with the export
                </Label>
                {/* Not asked for at once: the box above is ticked first. */}
                <OwnerConfirmFields
                  idPrefix="restore-owner"
                  username={username}
                  error={serverError}
                  autoPrompt={false}
                />
              </>
            ) : null}
            <FormError error={serverError} />
            <div className="flex gap-2">
              <Button
                type="submit"
                variant={inSettings ? "destructive" : "default"}
                disabled={pending}
              >
                {pending
                  ? "Restoring…"
                  : inSettings
                    ? "Replace everything"
                    : "Restore this export"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={back}
                disabled={pending}
              >
                Back
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  )
}

function PreviewList({ preview }: { preview: ExportPreview }) {
  const { counts } = preview
  const items = [
    plural(counts.servers, "server"),
    plural(counts.endpoints, "API endpoint"),
    plural(counts.mailAccounts, "mail account"),
    ...(counts.wrappers > 0 ? [plural(counts.wrappers, "wrapper")] : []),
    plural(counts.tools, "tool"),
    plural(counts.secrets, "secret"),
    plural(counts.tokens, "API token"),
    plural(counts.memories, "memory", "memories"),
    plural(counts.webFetchRules, "web fetch level"),
    plural(counts.pendingRequests, "request waiting", "requests waiting"),
    ...(counts.browserSites > 0
      ? [`browser sign-ins for ${plural(counts.browserSites, "site")}`]
      : []),
  ]

  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
      data-testid="restore-preview"
    >
      <dt className="text-muted-foreground">Exported</dt>
      <dd>
        <LocalDate value={preview.exportedAt} /> by PCP {preview.pcp}
      </dd>
      <dt className="text-muted-foreground">Owner</dt>
      <dd>{preview.vaultName}</dd>
      <dt className="text-muted-foreground">Public address</dt>
      <dd>{preview.publicUrl ?? "not set"}</dd>
      <dt className="text-muted-foreground">Holds</dt>
      <dd>{items.join(", ")}</dd>
    </dl>
  )
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Under the setup form: the other way to start. */
export function RestoreInsteadLink() {
  return (
    <p className="text-center text-sm text-muted-foreground">
      Moving from another PCP?{" "}
      <Link href="/setup/restore" className="text-primary hover:underline">
        Restore an export instead
      </Link>
    </p>
  )
}

type HostPreview = NonNullable<ExportPreview["host"]>

/** "dynamic DNS, HTTPS and the update check", for what the file holds. */
function hostSettingNames(host: HostPreview): string {
  const names = [
    host.ddns ? "dynamic DNS" : null,
    host.https ? "HTTPS" : null,
    host.updateCheck !== null ? "the update check" : null,
  ].filter((name): name is string => name !== null)

  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : (names[0] ?? "")
}

/** What restoring them does here, one sentence each. */
function hostSettingEffects(host: HostPreview): string {
  return [
    host.ddns
      ? host.ddnsName
        ? `${host.ddnsName} will then point at this machine.`
        : "Dynamic DNS will then update from this machine."
      : null,
    host.https ? "HTTPS asks Let's Encrypt for a certificate." : null,
    host.updateCheck === true
      ? "PCP checks for new releases once a day."
      : host.updateCheck === false
        ? "PCP does not check for new releases."
        : null,
  ]
    .filter(Boolean)
    .join(" ")
}
