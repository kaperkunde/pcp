"use client"

import { useActionState, useState } from "react"

import { SecretChoice } from "@/components/auth-fields-secret"
import {
  ChoiceField,
  FormFooter,
  FormSection,
  MoreOptions,
  NameFields,
  ServerFormFrame,
  SwitchGroup,
} from "@/components/server-form-parts"
import type { SecretOption } from "@/components/header-auth-fields"
import {
  OAuthClientFields,
  type OAuthClientValues,
} from "@/components/oauth-client-fields"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { SwitchRow } from "@/components/ui/switch"
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

const PROTOCOLS: ReadonlyArray<{ value: Protocol; label: string }> = [
  { value: "jmap", label: "JMAP" },
  { value: "imap", label: "IMAP and SMTP" },
]

const SIGN_IN: ReadonlyArray<{ value: MailAuth; label: string }> = [
  { value: "basic", label: "User name and password" },
  { value: "header", label: "Bearer token" },
  { value: "oauth", label: "OAuth" },
]

const SIGN_IN_HINT: Record<MailAuth, string> = {
  basic: "An app password, if the server offers them, rather than your own.",
  header: "An API token the mail server gave you.",
  oauth: "You sign in to the mail server from PCP.",
}

/**
 * Add or edit a mail account: a JMAP server (Stalwart, Fastmail and the
 * like) or an IMAP server with SMTP for sending. The password is one of
 * your secrets, chosen here, never typed in. Adding, the protocol, the
 * server and the sign-in come first, the sending address under "More
 * options"; editing, the form sits in the account page's "Advanced" and
 * shows everything. Fields are held in state so a refused submit keeps what
 * was typed.
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
  const [moreOpen] = useState(() => Boolean(initial.mailFrom))

  const imap = protocol === "imap"
  const auth: MailAuth = imap ? "basic" : authType

  const fromField = (
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
  )

  const readOnlyRow = (
    <SwitchRow
      id={`${prefix}-read-only`}
      name="readOnly"
      label="Read-only"
      description="Only the tools that read mail are offered, so nothing an assistant does here can send, move, flag or delete mail."
      checked={readOnly}
      onChange={(event) => setReadOnly(event.target.checked)}
    />
  )

  const server = imap ? (
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
          className="font-mono"
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
          className="font-mono"
        />
      </Field>
      <input type="hidden" name="authType" value="basic" />
    </>
  ) : (
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
        spellCheck={false}
        className="font-mono"
      />
    </Field>
  )

  const signIn = (
    <>
      {imap ? null : (
        <ChoiceField
          label="Sign-in"
          name="authType"
          options={SIGN_IN}
          value={authType}
          onValueChange={setAuthType}
          hint={SIGN_IN_HINT[authType]}
        />
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
              spellCheck={false}
              placeholder="ada@example.com"
            />
          </Field>
          <SecretChoice
            prefix={prefix}
            label="Password"
            secrets={secrets}
            value={secretId}
            onValueChange={setSecretId}
            hint={imap ? SIGN_IN_HINT.basic : undefined}
          />
        </div>
      ) : null}

      {auth === "header" ? (
        <SecretChoice
          prefix={prefix}
          label="Token"
          secrets={secrets}
          value={secretId}
          onValueChange={setSecretId}
          hint="Sent as Authorization: Bearer <token>."
        />
      ) : null}

      {auth === "oauth" ? (
        <OAuthClientFields
          prefix={prefix}
          secrets={secrets}
          initial={initial}
          redirectUrl={redirectUrl}
          foldClient={!editing}
          intro={
            <>
              After saving, choose{" "}
              <strong className="text-foreground">Connect</strong> on the
              account page to sign in. PCP registers itself with the mail server
              when it allows it. When it does not, create an OAuth client there
              with this redirect URI, and enter its client ID and secret here:
            </>
          }
          scopeHint="Leave empty to let the server decide. For Stalwart, offline_access keeps PCP signed in after the first token runs out."
        />
      ) : null}
    </>
  )

  if (editing) {
    return (
      <ServerFormFrame editing action={action}>
        <input type="hidden" name="id" value={initial.id} />
        <input type="hidden" name="protocol" value={protocol} />
        <FormSection>
          <NameFields
            prefix={prefix}
            editing
            name={name}
            onNameChange={setName}
            slug={slug}
            onSlugChange={setSlug}
            description={description}
            onDescriptionChange={setDescription}
            namePlaceholder="Work mail"
            descriptionHint="Whose mail this is and what it is for, in a sentence. An assistant reads this to tell your accounts apart."
            slugHint="How an assistant refers to this account in tool calls (account/tool). Lowercase letters, digits and dashes."
          />
        </FormSection>
        <FormSection>{server}</FormSection>
        <FormSection>{signIn}</FormSection>
        <FormSection>{fromField}</FormSection>
        <SwitchGroup>{readOnlyRow}</SwitchGroup>
        <FormFooter
          editing
          state={state}
          submitLabel="Save changes"
          pendingText="Saving…"
        />
      </ServerFormFrame>
    )
  }

  return (
    <ServerFormFrame editing={false} action={action}>
      <ChoiceField
        label="Protocol"
        name="protocol"
        options={PROTOCOLS}
        value={protocol}
        onValueChange={setProtocol}
        hint={
          imap
            ? "IMAP to read mail, with SMTP to send it."
            : "Stalwart, Fastmail, Cyrus and others."
        }
      />

      <NameFields
        prefix={prefix}
        editing={false}
        name={name}
        onNameChange={setName}
        slug={slug}
        onSlugChange={setSlug}
        description={description}
        onDescriptionChange={setDescription}
        namePlaceholder="Work mail"
        descriptionPlaceholder="My work mailbox, ada@example.com."
        descriptionHint="Whose mail this is and what it is for, in a sentence. An assistant reads this to tell your accounts apart."
        slugHint=""
      />

      <FormSection>{server}</FormSection>
      <FormSection>{signIn}</FormSection>

      <SwitchGroup>{readOnlyRow}</SwitchGroup>

      <MoreOptions
        description="The address mail is sent from."
        defaultOpen={moreOpen}
      >
        {fromField}
      </MoreOptions>

      <FormFooter
        editing={false}
        state={state}
        submitLabel="Add mail account"
        pendingText="Checking…"
      />
    </ServerFormFrame>
  )
}
