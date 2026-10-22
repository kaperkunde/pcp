"use client"

import { useActionState, useState } from "react"

import { BasicAuthFields } from "@/components/basic-auth-fields"
import {
  HeaderAuthFields,
  type ExtraHeaderValues,
  type SecretOption,
} from "@/components/header-auth-fields"
import { OAuthClientFields } from "@/components/oauth-client-fields"
import {
  ChoiceField,
  FormSection,
  ServerFormFrame,
} from "@/components/server-form-parts"
import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { ButtonLink } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  cloneServerAction,
  type DefinitionActionResult,
} from "@/lib/actions/definitions"
import { MAX_PERSONAL_NOTE } from "@/lib/core/constants"

type AuthType = "none" | "header" | "basic" | "oauth"

export type CloneSource = {
  id: string
  kind: "openapi" | "mcp"
  name: string
  authType: AuthType
  authUsername: string
  authHeaderName: string
  authValueTemplate: string
  /** The further headers' names and formats; each takes a secret of the clone's own. */
  authExtraHeaders: ExtraHeaderValues[]
  oauthScope: string
}

/**
 * Clone a server: only what is the new one's own. Its name, its address, how
 * it signs in there (the source's way, with a secret of its own), and your
 * note. The description, schema, edits and tool descriptions are the
 * definition's; the levels are copied from the source.
 */
export function CloneForm({
  source,
  secrets,
  redirectUrl,
}: {
  source: CloneSource
  secrets: SecretOption[]
  redirectUrl: string
}) {
  const [state, action] = useActionState<DefinitionActionResult, FormData>(
    cloneServerAction,
    { status: "idle" },
  )
  const endpoint = source.kind === "openapi"
  const prefix = `clone-${source.id}`
  const [name, setName] = useState(`${source.name} (copy)`)
  const [url, setUrl] = useState("")
  const [note, setNote] = useState("")
  const [authType, setAuthType] = useState<AuthType>(source.authType)
  const choices: Array<{ value: AuthType; label: string }> = [
    { value: "none", label: "None" },
    { value: "header", label: "Secret in a header" },
    ...(endpoint
      ? [{ value: "basic" as const, label: "User name and password" }]
      : []),
    { value: "oauth", label: "OAuth" },
  ]

  return (
    <ServerFormFrame editing={false} action={action}>
      <input type="hidden" name="sourceId" value={source.id} />

      <Field
        label="Name"
        htmlFor={`${prefix}-name`}
        hint="Its short name, what assistants call it, is made from this."
      >
        <Input
          id={`${prefix}-name`}
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          autoComplete="off"
        />
      </Field>

      <Field
        label={endpoint ? "Base URL" : "Address"}
        htmlFor={`${prefix}-url`}
        hint={
          endpoint
            ? "Where this one's requests go, e.g. https://cool.example.com/api/v1. Its secret goes only here."
            : "The MCP server's address (Streamable HTTP)."
        }
      >
        <Input
          id={`${prefix}-url`}
          name="url"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          spellCheck={false}
          className="font-mono"
          placeholder="https://"
        />
      </Field>

      <FormSection>
        <ChoiceField
          label="Sign-in"
          name="authType"
          options={choices}
          value={authType}
          onValueChange={setAuthType}
          hint="As the source signs in, with a secret of this one's own."
        />
        {authType === "header" ? (
          <HeaderAuthFields
            prefix={prefix}
            secrets={secrets}
            initial={{
              authSecretId: "",
              authHeaderName: source.authHeaderName,
              authValueTemplate: source.authValueTemplate,
              authExtraHeaders: source.authExtraHeaders.map((extra) => ({
                ...extra,
                secretId: "",
              })),
            }}
            foldHeader
          />
        ) : null}
        {authType === "basic" ? (
          <BasicAuthFields
            prefix={prefix}
            secrets={secrets}
            initial={{ authUsername: source.authUsername, authSecretId: "" }}
          />
        ) : null}
        {authType === "oauth" ? (
          <OAuthClientFields
            prefix={prefix}
            secrets={secrets}
            initial={{
              oauthClientId: "",
              oauthClientSecretId: "",
              oauthScope: source.oauthScope,
              oauthAuthorizeParams: "",
            }}
            redirectUrl={redirectUrl}
            foldClient
            scopeHint="Leave empty for the scope the source asks for."
            intro={
              <>
                After cloning, choose <strong>Connect</strong> on its page to
                sign in there.
              </>
            }
          />
        ) : null}
      </FormSection>

      <FormSection>
        <Field
          label="Your note (optional)"
          htmlFor={`${prefix}-note`}
          hint={`Which one this is, in your words: assistants read it beside the description. Private: never synced or shared. Up to ${MAX_PERSONAL_NOTE} characters.`}
        >
          <Input
            id={`${prefix}-note`}
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_PERSONAL_NOTE}
            autoComplete="off"
            placeholder="production, cool.example.com"
          />
        </Field>
      </FormSection>

      <div className="flex flex-col gap-3">
        <FormError error={state.status === "error" ? state.error : null} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ButtonLink href={`/servers/${source.id}`} variant="secondary">
            Cancel
          </ButtonLink>
          <SubmitButton pendingText="Cloning…">Clone</SubmitButton>
        </div>
      </div>
    </ServerFormFrame>
  )
}
