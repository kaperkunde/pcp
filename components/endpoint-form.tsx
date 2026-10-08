"use client"

import { useActionState, useState } from "react"

import { BasicAuthFields } from "@/components/basic-auth-fields"
import {
  ChoiceField,
  FormFooter,
  FormSection,
  MoreOptions,
  NameFields,
  ServerFormFrame,
  SwitchGroup,
} from "@/components/endpoint-form-parts"
import {
  HeaderAuthFields,
  type ExtraHeaderValues,
  type SecretOption,
} from "@/components/header-auth-fields"
import { LocalDate } from "@/components/local-date"
import {
  OAuthClientFields,
  type OAuthClientValues,
} from "@/components/oauth-client-fields"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { SwitchRow } from "@/components/ui/switch"
import {
  createEndpointAction,
  updateEndpointAction,
} from "@/lib/actions/endpoints"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
  MAX_SPEC_BYTES,
  SPEC_FILE_ACCEPT,
} from "@/lib/core/constants"

type AuthType = "none" | "header" | "basic" | "oauth"

export type EndpointFormValues = {
  id?: string
  name: string
  slug?: string
  description: string
  specSource: "url" | "upload"
  specUrl: string
  /** When editing: when PCP last read the schema. */
  specReadAt?: Date | null
  /** When editing: an assistant proposed the schema URL. */
  specUrlFromAssistant?: boolean
  /** Edits to the schema, as JSON Patch text; empty for none. */
  patches: string
  /** What the owner typed. Empty when editing: the saved address is below. */
  baseUrl: string
  /** When editing: where requests go now. */
  currentBaseUrl?: string
  readOnly: boolean
  /** Refuse private, local and link-local addresses. */
  publicOnly: boolean
  authType: AuthType
  authUsername: string
  authHeaderName: string
  authValueTemplate: string
  authSecretId: string
  authExtraHeaders: ExtraHeaderValues[]
} & OAuthClientValues

/**
 * A new endpoint starts read-only: the safe choice, and the one most owners
 * want from an API they are trying out. The form says how to widen it.
 */
export const EMPTY_ENDPOINT: EndpointFormValues = {
  name: "",
  description: "",
  specSource: "url",
  specUrl: "",
  patches: "",
  baseUrl: "",
  readOnly: true,
  publicOnly: false,
  authType: "none",
  authUsername: "",
  authHeaderName: DEFAULT_HEADER_NAME,
  authValueTemplate: DEFAULT_VALUE_TEMPLATE,
  authSecretId: "",
  authExtraHeaders: [],
  oauthClientId: "",
  oauthClientSecretId: "",
  oauthScope: "",
  oauthAuthorizeParams: "",
}

const SIGN_IN: ReadonlyArray<{ value: AuthType; label: string }> = [
  { value: "none", label: "None" },
  { value: "header", label: "Secret in a header" },
  { value: "basic", label: "User name and password" },
  { value: "oauth", label: "OAuth" },
]

const SIGN_IN_HINT: Record<AuthType, string> = {
  none: "The API is open: PCP sends no credential with its calls.",
  header: "An API key or token, sent in a header with every call.",
  basic: "HTTP Basic authentication, sent with every call.",
  oauth:
    "You sign in with your account, as the schema says; PCP keeps the token and renews it.",
}

/**
 * Add or edit an API endpoint: an API described by an OpenAPI schema, read
 * from a URL or an uploaded file. Adding, the schema, name and sign-in come
 * first and the rest is under "More options"; editing, the form sits in the
 * endpoint page's "Advanced" and shows everything. Text fields are held in
 * state because React resets an uncontrolled form after every action, a
 * refused one included, and a schema that does not read is the likeliest
 * refusal; a chosen file cannot be kept, only the rest.
 */
export function EndpointForm({
  initial,
  secrets,
  redirectUrl,
}: {
  initial: EndpointFormValues
  secrets: SecretOption[]
  /** Where OAuth providers send you back: what your client lists. */
  redirectUrl: string
}) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing ? updateEndpointAction : createEndpointAction,
    { status: "idle" },
  )
  const prefix = editing ? `endpoint-${initial.id}` : "endpoint-new"

  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(initial.slug ?? "")
  const [description, setDescription] = useState(initial.description)
  const [specSource, setSpecSource] = useState(initial.specSource)
  const [specUrl, setSpecUrl] = useState(initial.specUrl)
  const [patches, setPatches] = useState(initial.patches)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [readOnly, setReadOnly] = useState(initial.readOnly)
  const [publicOnly, setPublicOnly] = useState(initial.publicOnly)
  const [authType, setAuthType] = useState(initial.authType)
  // Open from the start when something in it is set; never closed under
  // the owner's typing.
  const [moreOpen] = useState(() =>
    Boolean(initial.baseUrl || initial.patches || initial.publicOnly),
  )

  const schemaField =
    specSource === "url" ? (
      <Field
        label="Schema URL"
        htmlFor={`${prefix}-spec-url`}
        hint="Where the OpenAPI document lives, e.g. https://api.example.com/openapi.json. PCP downloads it now and again whenever you re-read it."
      >
        <Input
          id={`${prefix}-spec-url`}
          name="specUrl"
          type="url"
          value={specUrl}
          onChange={(event) => setSpecUrl(event.target.value)}
          required
          spellCheck={false}
          className="font-mono"
          placeholder="https://"
        />
      </Field>
    ) : (
      <Field
        label="Schema file"
        htmlFor={`${prefix}-spec-file`}
        hint={`OpenAPI 3 as JSON or YAML, up to ${MAX_SPEC_BYTES / 1024 / 1024} MB.${editing ? " Choose a file to replace the stored schema; leave it empty to keep it." : ""}`}
      >
        <Input
          id={`${prefix}-spec-file`}
          name="specFile"
          type="file"
          accept={SPEC_FILE_ACCEPT}
          required={!editing || initial.specSource !== "upload"}
          className="py-2"
        />
      </Field>
    )

  const editsField = (
    <Field
      label="Edits (optional)"
      htmlFor={`${prefix}-patches`}
      hint={
        <>
          Changes PCP makes to the schema before it builds the tools, and makes
          again whenever the schema is read: a{" "}
          <a
            className="text-primary hover:underline"
            href="https://datatracker.ietf.org/doc/html/rfc6902"
            target="_blank"
            rel="noreferrer"
          >
            JSON Patch
          </a>
          , such as{" "}
          <code>{'[{"op": "remove", "path": "/paths/~1login"}]'}</code>. Leave
          it empty for none.
        </>
      }
    >
      <Textarea
        id={`${prefix}-patches`}
        name="patches"
        value={patches}
        onChange={(event) => setPatches(event.target.value)}
        rows={patches ? Math.min(16, patches.split("\n").length) : 2}
        spellCheck={false}
        className="font-mono text-xs md:text-xs"
        placeholder="[]"
      />
    </Field>
  )

  const baseUrlField = (
    <Field
      label="Base URL (optional)"
      htmlFor={`${prefix}-base-url`}
      hint={
        editing ? (
          <>
            Requests go to <code>{initial.currentBaseUrl}</code>. Leave this
            empty to keep that. PCP only sends a secret to an address you typed
            here, or to the origin the schema was downloaded from, so attaching
            one to an address that came from the schema means typing it to
            confirm.
          </>
        ) : (
          "Where the API lives. Leave it empty to use the address in the schema, unless you attach a secret or sign in with OAuth: then enter it, so PCP knows where you mean it to go. Once saved, PCP keeps this address even if the schema changes."
        )
      }
    >
      <Input
        id={`${prefix}-base-url`}
        name="baseUrl"
        type="url"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        spellCheck={false}
        className="font-mono"
        placeholder="https://api.example.com/v1"
      />
    </Field>
  )

  const readOnlyRow = (
    <SwitchRow
      id={`${prefix}-read-only`}
      name="readOnly"
      label="Read-only"
      description={
        editing
          ? "Only operations that read (GET) become tools, so nothing an assistant calls here can change data."
          : "Only operations that read (GET) become tools, so nothing an assistant calls here can change data. Recommended; turn it off to include the ones that change data."
      }
      checked={readOnly}
      onChange={(event) => setReadOnly(event.target.checked)}
    />
  )

  const publicOnlyRow = (
    <SwitchRow
      id={`${prefix}-public-only`}
      name="publicOnly"
      label="Public addresses only"
      description="Refuse private, local and link-local addresses, for the schema and for every call. On for endpoints an assistant registers; turn it off only for an API on your own network that you trust this endpoint to reach, or when this machine can only reach the internet through a proxy."
      checked={publicOnly}
      onChange={(event) => setPublicOnly(event.target.checked)}
    />
  )

  const signIn = (
    <>
      <ChoiceField
        label="Sign-in"
        name="authType"
        options={SIGN_IN}
        value={authType}
        onValueChange={setAuthType}
        hint={SIGN_IN_HINT[authType]}
      />
      {authType === "header" ? (
        <HeaderAuthFields
          prefix={prefix}
          secrets={secrets}
          initial={initial}
          foldHeader={!editing}
        />
      ) : null}
      {authType === "basic" ? (
        <BasicAuthFields prefix={prefix} secrets={secrets} initial={initial} />
      ) : null}
      {authType === "oauth" ? (
        <OAuthClientFields
          prefix={prefix}
          secrets={secrets}
          initial={initial}
          redirectUrl={redirectUrl}
          foldClient={!editing}
          scopeHint="Leave empty to ask for the scopes the operations PCP offers need, as the schema says."
          intro={
            <>
              PCP signs in where the schema&apos;s oauth2 flow (an authorization
              code flow) says, renews the token itself, and sends it to the base
              URL with every call. After saving, choose{" "}
              <strong className="text-foreground">Connect</strong> on the
              endpoint&apos;s page. PCP registers itself with a provider that
              allows it; most want a client you create in their developer
              settings with this redirect URI, its client ID and secret entered
              here:
            </>
          }
        />
      ) : null}
    </>
  )

  if (editing) {
    return (
      <ServerFormFrame editing action={action}>
        <input type="hidden" name="id" value={initial.id} />
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
            namePlaceholder="Petstore"
            descriptionHint="What this API is for, in a sentence or two. An assistant reads this to decide where to look for a tool; PCP fills it from the schema when you leave it empty."
            slugHint="How an assistant refers to this endpoint in tool calls (endpoint/tool). Lowercase letters, digits and dashes."
          />
        </FormSection>

        <FormSection>
          <ChoiceField
            label="Schema"
            name="specSource"
            options={[
              { value: "url", label: "From a URL" },
              { value: "upload", label: "Upload a file" },
            ]}
            value={specSource}
            onValueChange={setSpecSource}
            hint={
              <>
                {initial.specSource === "url" ? (
                  <>
                    Read from <code>{initial.specUrl}</code>
                    {initial.specUrlFromAssistant
                      ? ", an address an assistant proposed: when the document there changes, the tools stay as you approved them until you re-read it"
                      : null}
                  </>
                ) : (
                  "Uploaded as a file"
                )}
                {initial.specReadAt ? (
                  <>
                    {" "}
                    · read <LocalDate value={initial.specReadAt} />
                  </>
                ) : null}
                . Saving rebuilds the tools from PCP&apos;s copy of the schema.
              </>
            }
          />
          {schemaField}
          {editsField}
        </FormSection>

        <FormSection>{baseUrlField}</FormSection>

        <FormSection>{signIn}</FormSection>

        <SwitchGroup>
          {readOnlyRow}
          {publicOnlyRow}
        </SwitchGroup>

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
      <input type="hidden" name="specSource" value={specSource} />
      <div className="flex flex-col items-start gap-1.5">
        <div className="w-full">{schemaField}</div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-3"
          onClick={() => setSpecSource(specSource === "url" ? "upload" : "url")}
        >
          {specSource === "url" ? "Upload a file instead" : "Use a URL instead"}
        </Button>
      </div>

      <NameFields
        prefix={prefix}
        editing={false}
        name={name}
        onNameChange={setName}
        slug={slug}
        onSlugChange={setSlug}
        description={description}
        onDescriptionChange={setDescription}
        namePlaceholder="Petstore"
        descriptionPlaceholder="Pet store inventory: list, add and remove pets."
        descriptionHint="What this API is for, in a sentence or two. An assistant reads this to decide where to look for a tool; PCP fills it from the schema when you leave it empty."
        slugHint=""
      />

      <FormSection>{signIn}</FormSection>

      <SwitchGroup>{readOnlyRow}</SwitchGroup>

      <MoreOptions
        description="Base URL, edits to the schema, public addresses only."
        defaultOpen={moreOpen}
      >
        {baseUrlField}
        {editsField}
        <SwitchGroup>{publicOnlyRow}</SwitchGroup>
      </MoreOptions>

      <FormFooter
        editing={false}
        state={state}
        submitLabel="Add endpoint"
        pendingText="Reading schema…"
      />
    </ServerFormFrame>
  )
}
