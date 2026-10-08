"use client"

import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import type { SecretOption } from "@/components/header-auth-fields"
import {
  OAuthClientFields,
  type OAuthClientValues,
} from "@/components/oauth-client-fields"
import { SubmitButton } from "@/components/submit-button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import {
  createMailAccountAction,
  updateMailAccountAction,
} from "@/lib/actions/mail-accounts"
import type { ServerActionResult } from "@/lib/actions/servers"

type Protocol = "jmap" | "imap"
type MailAuth = "basic" | "header" | "oauth"

export type MailAccountFormValues = OAuthClientValues & {
  id?: string
  protocol: Protocol
  name: string
  slug?: string
  description: string
  url: string
  smtpUrl: string
  readOnly: boolean
  authType: MailAuth
  authUsername: string
  authSecretId: string
  mailFrom: string
}

export const EMPTY_MAIL_ACCOUNT: MailAccountFormValues = {
  protocol: "jmap",
  name: "",
  description: "",
  url: "",
  smtpUrl: "",
  readOnly: false,
  authType: "basic",
  authUsername: "",
  authSecretId: "",
  mailFrom: "",
  oauthClientId: "",
  oauthClientSecretId: "",
  oauthScope: "",
  oauthAuthorizeParams: "",
}

/**
 * Add or edit a mail account: a JMAP server (Stalwart, Fastmail and the
 * like) or an IMAP server with SMTP for sending. The password is one of
 * your secrets, chosen here, never typed in. Fields are held in state so a
 * refused submit keeps what was typed.
 */
export function MailAccountForm({
  initial,
  secrets,
  redirectUrl,
}: {
  initial: MailAccountFormValues
  secrets: SecretOption[]
  /** Where an OAuth sign-in comes back to: what a provider's client lists. */
  redirectUrl: string
}) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing ? updateMailAccountAction : createMailAccountAction,
    { status: "idle" },
  )
  const prefix = editing ? `mail-${initial.id}` : "mail-new"

  const [protocol, setProtocol] = useState<Protocol>(initial.protocol)
  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(initial.slug ?? "")
  const [description, setDescription] = useState(initial.description)
  const [url, setUrl] = useState(initial.url)
  const [smtpUrl, setSmtpUrl] = useState(initial.smtpUrl)
  const [readOnly, setReadOnly] = useState(initial.readOnly)
  const [authType, setAuthType] = useState<MailAuth>(initial.authType)
  const [username, setUsername] = useState(initial.authUsername)
  const [secretId, setSecretId] = useState(initial.authSecretId)
  const [mailFrom, setMailFrom] = useState(initial.mailFrom)

  const imap = protocol === "imap"
  const auth: MailAuth = imap ? "basic" : authType

  return (
    <Card>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {editing ? (
            <input type="hidden" name="id" value={initial.id} />
          ) : null}

          {editing ? (
            <input type="hidden" name="protocol" value={protocol} />
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Protocol</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <Label className="font-normal">
                  <input
                    type="radio"
                    name="protocol"
                    value="jmap"
                    className="accent-primary"
                    checked={protocol === "jmap"}
                    onChange={() => setProtocol("jmap")}
                  />
                  JMAP: Stalwart, Fastmail, Cyrus and others
                </Label>
                <Label className="font-normal">
                  <input
                    type="radio"
                    name="protocol"
                    value="imap"
                    className="accent-primary"
                    checked={protocol === "imap"}
                    onChange={() => setProtocol("imap")}
                  />
                  IMAP, with SMTP to send
                </Label>
              </div>
            </fieldset>
          )}

          <Field label="Name" htmlFor={`${prefix}-name`}>
            <Input
              id={`${prefix}-name`}
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
              placeholder="Work mail"
            />
          </Field>

          {editing ? (
            <Field
              label="Short name"
              htmlFor={`${prefix}-slug`}
              hint="How an assistant refers to this account in tool calls (account/tool). Lowercase letters, digits and dashes."
            >
              <Input
                id={`${prefix}-slug`}
                name="slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                pattern="[a-z0-9-]+"
                maxLength={40}
              />
            </Field>
          ) : null}

          <Field
            label="Description"
            htmlFor={`${prefix}-description`}
            hint="Whose mail this is and what it is for, in a sentence. An assistant reads this to tell your accounts apart."
          >
            <Textarea
              id={`${prefix}-description`}
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={1000}
              placeholder="My work mailbox, ada@example.com."
            />
          </Field>

          {imap ? (
            <>
              <Field
                label="IMAP server"
                htmlFor={`${prefix}-url`}
                hint="imaps://mail.example.com:993, or imap://mail.example.com:143 to upgrade with STARTTLS. A host name alone means imaps on port 993. PCP never signs in over a connection that is not encrypted."
              >
                <Input
                  id={`${prefix}-url`}
                  name="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                  placeholder="imaps://mail.example.com:993"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="SMTP server (optional)"
                htmlFor={`${prefix}-smtp-url`}
                hint="Where mail is sent from, with the same user name and password: smtps://mail.example.com:465, or smtp://mail.example.com:587 for STARTTLS. Leave it empty and the account cannot send."
              >
                <Input
                  id={`${prefix}-smtp-url`}
                  name="smtpUrl"
                  value={smtpUrl}
                  onChange={(event) => setSmtpUrl(event.target.value)}
                  placeholder="smtps://mail.example.com:465"
                  spellCheck={false}
                />
              </Field>
              <input type="hidden" name="authType" value="basic" />
            </>
          ) : (
            <>
              <Field
                label="Session URL"
                htmlFor={`${prefix}-url`}
                hint="Usually https://mail.example.com/.well-known/jmap. PCP reads it to find the account's mail, and only sends your credentials to that address's host. It must be https://, except for a server on your own network."
              >
                <Input
                  id={`${prefix}-url`}
                  name="url"
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                  placeholder="https://mail.example.com/.well-known/jmap"
                />
              </Field>
              <Field label="Authentication" htmlFor={`${prefix}-auth`}>
                <Select
                  id={`${prefix}-auth`}
                  name="authType"
                  value={authType}
                  onChange={(event) =>
                    setAuthType(event.target.value as MailAuth)
                  }
                >
                  <option value="basic">
                    User name and password: an app password
                  </option>
                  <option value="header">Bearer token: an API token</option>
                  <option value="oauth">
                    OAuth: sign in to the mail server from PCP
                  </option>
                </Select>
              </Field>
            </>
          )}

          {auth === "basic" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="User name" htmlFor={`${prefix}-username`}>
                <Input
                  id={`${prefix}-username`}
                  name="authUsername"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  autoComplete="off"
                  placeholder="ada@example.com"
                />
              </Field>
              <SecretField
                prefix={prefix}
                label="Password"
                secrets={secrets}
                value={secretId}
                onChange={setSecretId}
                hint="An app password, if the server offers them, rather than your own."
              />
            </div>
          ) : null}

          {auth === "header" ? (
            <SecretField
              prefix={prefix}
              label="Token"
              secrets={secrets}
              value={secretId}
              onChange={setSecretId}
              hint="Sent as Authorization: Bearer <token>."
            />
          ) : null}

          {auth === "oauth" ? (
            <OAuthClientFields
              prefix={prefix}
              secrets={secrets}
              initial={initial}
              redirectUrl={redirectUrl}
              intro={
                <>
                  After saving, choose <strong>Connect</strong> on the account
                  page to sign in. PCP registers itself with the mail server
                  when it allows it. When it does not, create an OAuth client
                  there with this redirect URI, and enter its client ID and
                  secret here:
                </>
              }
              scopeHint="Leave empty to let the server decide. For Stalwart, offline_access keeps PCP signed in after the first token runs out."
            />
          ) : null}

          <Field
            label="From address (optional)"
            htmlFor={`${prefix}-from`}
            hint={
              imap
                ? "The address mail is sent from. Leave it empty to use the user name."
                : "The identity to send as, when the account has several. Leave it empty to use the account's own."
            }
          >
            <Input
              id={`${prefix}-from`}
              name="mailFrom"
              type="email"
              value={mailFrom}
              onChange={(event) => setMailFrom(event.target.value)}
              placeholder="ada@example.com"
            />
          </Field>

          <div className="flex flex-col gap-1.5">
            <Label className="font-normal" htmlFor={`${prefix}-read-only`}>
              <Checkbox
                id={`${prefix}-read-only`}
                name="readOnly"
                checked={readOnly}
                onChange={(event) => setReadOnly(event.target.checked)}
              />
              Read-only
            </Label>
            <p className="text-xs text-muted-foreground">
              Only the tools that read mail are offered, so nothing an assistant
              does here can send, move, flag or delete mail.
            </p>
          </div>

          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText={editing ? "Saving…" : "Checking…"}>
              {editing ? "Save changes" : "Add mail account"}
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function SecretField({
  prefix,
  label,
  secrets,
  value,
  onChange,
  hint,
}: {
  prefix: string
  label: string
  secrets: SecretOption[]
  value: string
  onChange: (value: string) => void
  hint: string
}) {
  return (
    <Field
      label={label}
      htmlFor={`${prefix}-secret`}
      hint={
        secrets.length === 0
          ? "Add it under Secrets first, then pick it here."
          : `${hint} Stored encrypted; PCP sends it, the assistant never sees it.`
      }
    >
      <Select
        id={`${prefix}-secret`}
        name="authSecretId"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      >
        <option value="">Choose a secret…</option>
        {secrets.map((secret) => (
          <option key={secret.id} value={secret.id}>
            {secret.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}
