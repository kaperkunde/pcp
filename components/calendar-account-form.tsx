"use client"

import { useActionState, useState } from "react"

import { SecretChoice } from "@/components/auth-fields-secret"
import type { SecretOption } from "@/components/header-auth-fields"
import {
  OAuthClientFields,
  type OAuthClientValues,
} from "@/components/oauth-client-fields"
import {
  ChoiceField,
  FormFooter,
  FormSection,
  NameFields,
  ServerFormFrame,
  SwitchGroup,
} from "@/components/server-form-parts"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { SwitchRow } from "@/components/ui/switch"
import {
  createCalendarAccountAction,
  updateCalendarAccountAction,
} from "@/lib/actions/calendar-accounts"
import type { ServerActionResult } from "@/lib/actions/servers"

type Provider = "icloud" | "fastmail" | "other"
type CalendarAuth = "basic" | "header" | "oauth"

export type CalendarAccountFormValues = OAuthClientValues & {
  id?: string
  name: string
  slug?: string
  description: string
  url: string
  readOnly: boolean
  authType: CalendarAuth
  authUsername: string
  authSecretId: string
}

export const EMPTY_CALENDAR_ACCOUNT: CalendarAccountFormValues = {
  name: "iCloud",
  description: "",
  url: "https://caldav.icloud.com/",
  readOnly: false,
  authType: "basic",
  authUsername: "",
  authSecretId: "",
  oauthClientId: "",
  oauthClientSecretId: "",
  oauthScope: "",
  oauthAuthorizeParams: "",
}

const PROVIDERS: ReadonlyArray<{ value: Provider; label: string }> = [
  { value: "icloud", label: "iCloud" },
  { value: "fastmail", label: "Fastmail" },
  { value: "other", label: "Other CalDAV" },
]

const PRESETS: Record<
  Provider,
  { name: string; url: string; username: string; password: string }
> = {
  icloud: {
    name: "iCloud",
    url: "https://caldav.icloud.com/",
    username: "Your Apple ID, usually your email address.",
    password:
      "An app-specific password, made at appleid.apple.com under Sign-In and Security. Your Apple ID password does not work here.",
  },
  fastmail: {
    name: "Fastmail",
    url: "https://caldav.fastmail.com/",
    username: "Your Fastmail address.",
    password:
      "An app password with calendar access, made in Fastmail's settings under Privacy & Security.",
  },
  other: {
    name: "",
    url: "",
    username: "The login for the calendar server.",
    password:
      "An app password, if the server offers them, rather than your own.",
  },
}

const SIGN_IN: ReadonlyArray<{ value: CalendarAuth; label: string }> = [
  { value: "basic", label: "User name and password" },
  { value: "header", label: "Bearer token" },
  { value: "oauth", label: "OAuth" },
]

function providerOf(url: string): Provider {
  return url.includes("icloud.com")
    ? "icloud"
    : url.includes("fastmail.com")
      ? "fastmail"
      : "other"
}

/**
 * Add or edit a calendar account: calendars and reminders over CalDAV.
 * Adding, iCloud comes first, with the address filled in and what its
 * app-specific password is; Fastmail likewise; any other server by its
 * address. The password can be typed in here (it is saved under Secrets) or
 * picked from the secrets you hold. Editing, the form sits in the account
 * page's "Advanced" and shows everything. Fields are held in state so a
 * refused submit keeps what was typed.
 */
export function CalendarAccountForm({
  initial,
  secrets,
  redirectUrl,
}: {
  initial: CalendarAccountFormValues
  secrets: SecretOption[]
  /** Where an OAuth sign-in comes back to: what a provider's client lists. */
  redirectUrl: string
}) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing ? updateCalendarAccountAction : createCalendarAccountAction,
    { status: "idle" },
  )
  const prefix = editing ? `calendar-${initial.id}` : "calendar-new"

  const [provider, setProvider] = useState<Provider>(providerOf(initial.url))
  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(initial.slug ?? "")
  const [description, setDescription] = useState(initial.description)
  const [url, setUrl] = useState(initial.url)
  const [readOnly, setReadOnly] = useState(initial.readOnly)
  const [authType, setAuthType] = useState<CalendarAuth>(initial.authType)
  const [username, setUsername] = useState(initial.authUsername)
  const [secretId, setSecretId] = useState(initial.authSecretId)

  const preset = PRESETS[provider]
  const known = provider !== "other"
  // iCloud and Fastmail take a login and an app password, nothing else.
  const auth: CalendarAuth = known ? "basic" : authType

  function chooseProvider(next: Provider) {
    // The name and address follow the provider while they are its own.
    if (!name || name === PRESETS[provider].name) {
      setName(PRESETS[next].name)
    }

    if (!url || url === PRESETS[provider].url) {
      setUrl(PRESETS[next].url)
    }

    setProvider(next)
  }

  const address = (
    <Field
      label="CalDAV server"
      htmlFor={`${prefix}-url`}
      hint={
        known
          ? "PCP finds your calendars and reminder lists from here."
          : "The server's address, like https://caldav.example.com, or a Nextcloud's https://cloud.example.com/remote.php/dav. PCP finds your calendars from it, and sends your sign-in only to that host and others of its domain. It must be https://, except for a server on your own network."
      }
    >
      <Input
        id={`${prefix}-url`}
        name="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        required
        placeholder="https://caldav.example.com"
        spellCheck={false}
        className="font-mono"
      />
    </Field>
  )

  const signIn = (
    <>
      {known ? (
        <input type="hidden" name="authType" value="basic" />
      ) : (
        <ChoiceField
          label="Sign-in"
          name="authType"
          options={SIGN_IN}
          value={authType}
          onValueChange={setAuthType}
          hint={
            authType === "basic"
              ? preset.password
              : authType === "header"
                ? "A token the calendar server gave you, sent as Authorization: Bearer <token>."
                : "You sign in to the calendar server from PCP."
          }
        />
      )}

      {auth === "basic" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="User name"
            htmlFor={`${prefix}-username`}
            hint={preset.username}
          >
            <Input
              id={`${prefix}-username`}
              name="authUsername"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder={provider === "icloud" ? "ada@icloud.com" : "ada"}
            />
          </Field>
          <SecretChoice
            prefix={prefix}
            label={known ? "App password" : "Password"}
            secrets={secrets}
            value={secretId}
            onValueChange={setSecretId}
            hint={known ? preset.password : undefined}
            typeNew={{
              option: "A new password, entered here",
              valueLabel: known ? "App password" : "New password",
              valueHint: known
                ? preset.password
                : "PCP sends it with the user name; an assistant never sees it.",
              nameHint: "Left empty, it is named after this account.",
            }}
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
          typeNew={{
            option: "A new token, entered here",
            valueLabel: "Token",
            valueHint: "PCP sends it; an assistant never sees it.",
            nameHint: "Left empty, it is named after this account.",
          }}
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
              account page to sign in. PCP registers itself with the calendar
              server when it allows it. When it does not, create an OAuth client
              there with this redirect URI, and enter its client ID and secret
              here:
            </>
          }
          scopeHint="Leave empty to let the server decide."
        />
      ) : null}
    </>
  )

  const readOnlyRow = (
    <SwitchRow
      id={`${prefix}-read-only`}
      name="readOnly"
      label="Read-only"
      description="Only the tools that read calendars and reminders are offered, so nothing an assistant does here can add, change or delete an event or a reminder."
      checked={readOnly}
      onChange={(event) => setReadOnly(event.target.checked)}
    />
  )

  const reminders =
    provider === "icloud" ? (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Reminders: iCloud serves over CalDAV only the reminder lists it keeps as
        tasks. Lists upgraded in Apple&apos;s Reminders app stay in the app, and
        an assistant does not see them.
      </p>
    ) : null

  const nameFields = (
    <NameFields
      prefix={prefix}
      editing={editing}
      name={name}
      onNameChange={setName}
      slug={slug}
      onSlugChange={setSlug}
      description={description}
      onDescriptionChange={setDescription}
      namePlaceholder="iCloud"
      descriptionPlaceholder={
        editing ? undefined : "My personal calendars and reminders."
      }
      descriptionHint="Whose calendars these are and what they are for, in a sentence. An assistant reads this to tell your accounts apart."
      slugHint={
        editing
          ? "How an assistant refers to this account in tool calls (account/tool). Lowercase letters, digits and dashes."
          : ""
      }
    />
  )

  if (editing) {
    return (
      <ServerFormFrame editing action={action}>
        <input type="hidden" name="id" value={initial.id} />
        <FormSection>{nameFields}</FormSection>
        <FormSection>{address}</FormSection>
        <FormSection>{signIn}</FormSection>
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
        label="Provider"
        name="provider"
        options={PROVIDERS}
        value={provider}
        onValueChange={chooseProvider}
        hint={
          provider === "other"
            ? "Nextcloud, Radicale, Baïkal, Zimbra and other CalDAV servers."
            : undefined
        }
      />

      {nameFields}

      <FormSection>{address}</FormSection>
      <FormSection>
        {signIn}
        {reminders}
      </FormSection>

      <SwitchGroup>{readOnlyRow}</SwitchGroup>

      <FormFooter
        editing={false}
        state={state}
        submitLabel="Add calendar account"
        pendingText="Checking…"
      />
    </ServerFormFrame>
  )
}
