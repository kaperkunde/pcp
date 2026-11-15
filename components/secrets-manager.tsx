"use client"

import { useActionState, useState, useTransition } from "react"

import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { LocalDate, RelativeDate } from "@/components/local-date"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { Badge } from "@kaperkunde/ui/badge"
import { Button } from "@kaperkunde/ui/button"
import { Card } from "@kaperkunde/ui/card"
import { Checkbox, Input, Select, Textarea } from "@kaperkunde/ui/input"
import { Field, Label } from "@kaperkunde/ui/label"
import { List, ListRow, ListSection } from "@kaperkunde/ui/list"
import {
  addSecretOriginAction,
  deleteSecretAction,
  endSecretAllowanceAction,
  removeSecretOriginAction,
  revealSecretAction,
  revealTotpCodeAction,
  updateSecretAction,
  type SecretActionResult,
} from "@/lib/actions/secrets"
import type { SecretSite } from "@/lib/core/browser-secrets"
import type { SecretSummary } from "@/lib/core/secrets"

/** A token's allowance to have the secret typed at a site. */
export type SecretAllowanceItem = {
  tokenId: string
  tokenName: string
  origin: string
  /** Null: always. */
  until: string | null
  once: boolean
}

export type SecretItem = SecretSummary & {
  /** The sites the browser may type it at, each maybe with its subdomains. */
  browserOrigins: SecretSite[]
  allowances: SecretAllowanceItem[]
}

/**
 * The stored secrets, one row each: its name, what it is for, the servers
 * that use it and when it was last used; Reveal shows the value on the
 * owner's own screen, Edit renames it, rotates its value or says what
 * sign-in it belongs to (a login name, a note and, for a text secret, the
 * one-time codes that go with it: what assistants see beside its name). A
 * one-time codes secret also shows its code of the moment (Code). Browser lists the
 * sites the browser may type one of the owner's secrets at, and the tokens
 * allowed to have it typed there, each with a way to take it back.
 */
export function SecretsManager({ secrets }: { secrets: SecretItem[] }) {
  const codes = secrets
    .filter((secret) => secret.kind === "totp")
    .map((secret) => ({ id: secret.id, name: secret.name }))

  return (
    <ListSection
      title={`Stored secrets (${secrets.length})`}
      description="Values are encrypted at rest and only ever sent to the server that uses them. Reveal one to check it; edit it to rotate it."
    >
      {secrets.length === 0 ? (
        <Card>
          <p className="text-muted-foreground">
            Nothing stored yet. Add a secret for a server that needs a key or a
            token.
          </p>
        </Card>
      ) : (
        <List as="ul">
          {secrets.map((secret) => (
            <SecretRow key={secret.id} secret={secret} codes={codes} />
          ))}
        </List>
      )}
    </ListSection>
  )
}

function SecretRow({
  secret,
  codes,
}: {
  secret: SecretItem
  /** The one-time code secrets a text secret can name as its companion. */
  codes: Array<{ id: string; name: string }>
}) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [code, setCode] = useState<{
    code: string
    secondsLeft: number
  } | null>(null)
  const [browser, setBrowser] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [state, action] = useActionState<SecretActionResult, FormData>(
    updateSecretAction,
    { status: "idle" },
  )

  function reveal() {
    if (revealed !== null) {
      setRevealed(null)
      return
    }

    startTransition(async () => {
      const result = await revealSecretAction(secret.id)
      if (result.status === "ok") {
        setRevealed(result.value)
        setError(null)
      } else if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  function showCode() {
    if (code !== null) {
      setCode(null)
      return
    }

    startTransition(async () => {
      const result = await revealTotpCodeAction(secret.id)
      if (result.status === "ok") {
        setCode({ code: result.code, secondsLeft: result.secondsLeft })
        setError(null)
      } else if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  function removeOrigin(origin: string) {
    startTransition(async () => {
      const result = await removeSecretOriginAction(secret.id, origin)
      if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  function endAllowance(allowance: SecretAllowanceItem) {
    startTransition(async () => {
      const result = await endSecretAllowanceAction(
        allowance.tokenId,
        secret.id,
        allowance.origin,
      )
      if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  function remove() {
    if (!window.confirm(`Delete the secret "${secret.name}"?`)) {
      return
    }

    startTransition(async () => {
      const result = await deleteSecretAction(secret.id)
      if (result.status === "error") {
        setError(result.error)
      }
    })
  }

  const totp = secret.kind === "totp"
  const managed = secret.kind !== "text" && !totp
  const open =
    revealed !== null || code !== null || browser || editing || error !== null

  return (
    <ListRow
      as="li"
      className="items-start py-3.5"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{secret.name}</span>
          {managed ? (
            <Badge variant="secondary">
              {secret.kind === "ssh_key"
                ? "SSH key"
                : secret.kind === "proxy_password"
                  ? "Proxy password"
                  : "OAuth tokens"}
            </Badge>
          ) : null}
          {totp ? <Badge variant="secondary">One-time codes</Badge> : null}
          {secret.browserOrigins.length > 0 ? (
            <Badge variant="secondary">
              Browser: {secret.browserOrigins.length}{" "}
              {secret.browserOrigins.length === 1 ? "site" : "sites"}
            </Badge>
          ) : null}
          {secret.usedBy.map((server) => (
            <Badge key={server.id} variant="secondary">
              {server.name}
            </Badge>
          ))}
        </span>
      }
      description={
        <>
          {secret.description ? (
            <span className="block text-sm text-foreground/80">
              {secret.description}
            </span>
          ) : null}
          {secret.loginName || secret.totpCompanion || secret.note ? (
            <span className="block text-sm break-words text-foreground/80">
              {[
                secret.loginName ? `Login: ${secret.loginName}` : null,
                secret.totpCompanion
                  ? `Codes: ${secret.totpCompanion.name}`
                  : null,
                secret.note,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
          <span className="block">
            Updated <LocalDate value={secret.updatedAt} /> · last used{" "}
            <RelativeDate value={secret.lastUsedAt} />
          </span>
        </>
      }
      trailing={
        <div className="flex flex-wrap justify-end gap-1">
          {totp ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={showCode}
            >
              {code !== null ? "Hide code" : "Code"}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" disabled={pending} onClick={reveal}>
            {revealed !== null ? "Hide" : "Reveal"}
          </Button>
          {!managed ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setBrowser((value) => !value)}
            >
              {browser ? "Close" : "Browser"}
            </Button>
          ) : null}
          {!managed ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing((value) => !value)}
            >
              {editing ? "Cancel" : "Edit"}
            </Button>
          ) : null}
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
      {open ? (
        <div className="order-last flex basis-full flex-col gap-3">
          {code !== null ? (
            <p className="m-0 rounded-xl bg-field p-3.5 ring-1 ring-separator">
              <span className="font-mono text-lg tracking-widest">
                {code.code}
              </span>{" "}
              <span className="text-sm text-muted-foreground">
                for {code.secondsLeft} more seconds. Only you see it here; the
                browser types the code of the moment itself.
              </span>
            </p>
          ) : null}
          {revealed !== null ? (
            <pre className="m-0 max-h-48 overflow-auto rounded-xl bg-field p-3.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap ring-1 ring-separator">
              {revealed}
            </pre>
          ) : null}
          {browser ? (
            <SecretBrowser
              secret={secret}
              pending={pending}
              onRemoveOrigin={removeOrigin}
              onEndAllowance={endAllowance}
            />
          ) : null}
          {editing ? (
            <form
              action={action}
              className="flex flex-col gap-4 rounded-xl bg-field p-4 ring-1 ring-separator"
            >
              <input type="hidden" name="id" value={secret.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor={`secret-${secret.id}-name`}>
                  <Input
                    id={`secret-${secret.id}-name`}
                    name="name"
                    defaultValue={secret.name}
                    required
                    maxLength={100}
                  />
                </Field>
                <Field
                  label="Description"
                  htmlFor={`secret-${secret.id}-description`}
                >
                  <Input
                    id={`secret-${secret.id}-description`}
                    name="description"
                    defaultValue={secret.description}
                    maxLength={500}
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Login name"
                  htmlFor={`secret-${secret.id}-login`}
                  hint="The email or user name it signs in with. Assistants see it, never the value."
                >
                  <Input
                    id={`secret-${secret.id}-login`}
                    name="loginName"
                    defaultValue={secret.loginName ?? ""}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field
                  label="Note"
                  htmlFor={`secret-${secret.id}-note`}
                  hint="One line assistants see with its name."
                >
                  <Input
                    id={`secret-${secret.id}-note`}
                    name="note"
                    defaultValue={secret.note ?? ""}
                    maxLength={300}
                  />
                </Field>
              </div>
              {!totp ? (
                <Field
                  label="One-time codes"
                  htmlFor={`secret-${secret.id}-totp`}
                  hint="The one-time code secret that goes with this sign-in, named with it."
                >
                  <Select
                    id={`secret-${secret.id}-totp`}
                    name="totpCompanionId"
                    defaultValue={secret.totpCompanion?.id ?? ""}
                  >
                    <option value="">None</option>
                    {codes.map((code) => (
                      <option key={code.id} value={code.id}>
                        {code.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field
                label={totp ? "New seed" : "New value"}
                htmlFor={`secret-${secret.id}-value`}
                hint={
                  totp
                    ? "The base32 text or the otpauth:// link. Leave empty to keep the current seed."
                    : "Leave empty to keep the current value."
                }
              >
                <Textarea
                  id={`secret-${secret.id}-value`}
                  name="value"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-14 font-mono"
                />
              </Field>
              <FormError
                error={state.status === "error" ? state.error : null}
              />
              <div>
                <SubmitButton pendingText="Saving…">Save</SubmitButton>
              </div>
            </form>
          ) : null}
          <FormError error={error} />
          <FormNote message={state.status === "ok" ? state.message : null} />
        </div>
      ) : null}
    </ListRow>
  )
}

/**
 * Where the browser may type one of the owner's secrets: its sites, which
 * the owner adds or takes away, and the tokens allowed to have it typed
 * there without asking, each with End.
 */
function SecretBrowser({
  secret,
  pending,
  onRemoveOrigin,
  onEndAllowance,
}: {
  secret: SecretItem
  pending: boolean
  onRemoveOrigin: (origin: string) => void
  onEndAllowance: (allowance: SecretAllowanceItem) => void
}) {
  const [state, action] = useActionState<SecretActionResult, FormData>(
    addSecretOriginAction,
    { status: "idle" },
  )

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-field p-4 ring-1 ring-separator">
      <p className="m-0 text-sm text-muted-foreground">
        An assistant can have PCP type this secret into a page with the
        browser&apos;s type tool, without seeing it: at these sites, and only
        once you allow its token there. A use anywhere else asks you first.
      </p>
      {secret.browserOrigins.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {secret.browserOrigins.map((site) => (
            <li key={site.origin} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all">
                <code>{site.origin}</code>
                {site.subdomains ? (
                  <span className="text-sm text-muted-foreground">
                    {" "}
                    and its subdomains
                  </span>
                ) : null}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => onRemoveOrigin(site.origin)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm">No sites yet.</p>
      )}
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={secret.id} />
        <div className="min-w-48 flex-1">
          <Field label="Add a site" htmlFor={`secret-${secret.id}-origin`}>
            <Input
              id={`secret-${secret.id}-origin`}
              name="origin"
              required
              placeholder="https://example.com"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        </div>
        <SubmitButton size="sm" pendingText="Adding…">
          Add
        </SubmitButton>
        <Label className="w-full font-normal">
          <Checkbox name="subdomains" />
          <span>
            And its subdomains (www., login., mijn.…), within the same domain
            only. Adding a site again sets this anew.
          </span>
        </Label>
      </form>
      <FormError error={state.status === "error" ? state.error : null} />
      {secret.allowances.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Allowed tokens</span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {secret.allowances.map((allowance) => (
              <li
                key={`${allowance.tokenId}:${allowance.origin}`}
                className="flex items-center gap-2 text-sm"
              >
                <span className="min-w-0 flex-1 break-words">
                  {allowance.tokenName} at <code>{allowance.origin}</code>
                  {", "}
                  {allowance.until === null ? (
                    "always"
                  ) : (
                    <>
                      {allowance.once ? "its next use, until " : "until "}
                      <LocalDate value={allowance.until} />
                    </>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => onEndAllowance(allowance)}
                >
                  End
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
