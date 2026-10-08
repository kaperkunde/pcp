"use client"

import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import {
  HeaderAuthFields,
  type ExtraHeaderValues,
  type SecretOption,
} from "@/components/header-auth-fields"
import { OAuthClientFields } from "@/components/oauth-client-fields"
import { SubmitButton } from "@/components/submit-button"
import { Card } from "@/components/ui/card"
import { Disclosure } from "@/components/ui/disclosure"
import { Input, Select, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  createServerAction,
  updateServerAction,
  type ServerActionResult,
} from "@/lib/actions/servers"
import type { AuthType } from "@/lib/core/servers"
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
} from "@/lib/core/constants"

export type { SecretOption }

export type ServerFormValues = {
  id?: string
  name: string
  slug?: string
  url: string
  description: string
  authType: AuthType
  authHeaderName: string
  authValueTemplate: string
  authSecretId: string
  authExtraHeaders: ExtraHeaderValues[]
  oauthClientId: string
  oauthClientSecretId: string
  oauthScope: string
  oauthAuthorizeParams: string
}

export const EMPTY_SERVER: ServerFormValues = {
  name: "",
  url: "",
  description: "",
  authType: "none",
  authHeaderName: DEFAULT_HEADER_NAME,
  authValueTemplate: DEFAULT_VALUE_TEMPLATE,
  authSecretId: "",
  authExtraHeaders: [],
  oauthClientId: "",
  oauthClientSecretId: "",
  oauthScope: "",
  oauthAuthorizeParams: "",
}

/**
 * Add or edit a server. Mirrors what an assistant's own "add connector"
 * dialog asks for — name, URL, and how to authenticate — with PCP's own
 * secrets as the values, never the values themselves. Adding, an OAuth
 * client of the owner's own is folded under More options: PCP registers
 * itself wherever the server lets it. Editing, the form sits under the
 * server page's Advanced, all of it in view.
 */
export function ServerForm({
  initial,
  secrets,
  redirectUrl,
}: {
  initial: ServerFormValues
  secrets: SecretOption[]
  /** Where OAuth servers send you back: what a provider's client lists. */
  redirectUrl: string
}) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing ? updateServerAction : createServerAction,
    { status: "idle" },
  )
  const [authType, setAuthType] = useState<AuthType>(initial.authType)
  const prefix = editing ? `server-${initial.id}` : "server-new"

  const oauthFields =
    authType === "oauth" ? (
      <OAuthClientFields
        prefix={prefix}
        secrets={secrets}
        initial={initial}
        redirectUrl={redirectUrl}
        scopeHint="Leave empty to let the server decide."
        intro={
          editing ? (
            <>
              Choose <strong>Connect</strong> at the top of the page to sign in.
              PCP registers itself with the server when the server allows it.
              When it does not, create an OAuth client in the provider&apos;s
              developer settings with this redirect URI, and enter its client ID
              and secret here:
            </>
          ) : (
            <>
              Only for a server that lets no app register itself: create an
              OAuth client in the provider&apos;s developer settings with this
              redirect URI, and enter its client ID and secret here.
            </>
          )
        }
      />
    ) : null

  const form = (
    <form action={action} className="flex flex-col gap-5">
      {editing ? <input type="hidden" name="id" value={initial.id} /> : null}

      <Field label="Name" htmlFor={`${prefix}-name`}>
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={initial.name}
          required
          maxLength={80}
          placeholder="GitHub"
        />
      </Field>

      {editing ? (
        <Field
          label="Short name"
          htmlFor={`${prefix}-slug`}
          hint="How an assistant refers to this server in tool calls (server/tool). Lowercase letters, digits and dashes."
        >
          <Input
            id={`${prefix}-slug`}
            name="slug"
            defaultValue={initial.slug}
            pattern="[a-z0-9-]+"
            maxLength={40}
          />
        </Field>
      ) : null}

      <Field
        label="Server URL"
        htmlFor={`${prefix}-url`}
        hint="The Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp."
      >
        <Input
          id={`${prefix}-url`}
          name="url"
          type="url"
          defaultValue={initial.url}
          required
          placeholder="https://"
        />
      </Field>

      <Field
        label="Description"
        htmlFor={`${prefix}-description`}
        hint="What this server is for, in a sentence or two. An assistant reads this to decide where to look for a tool; PCP fills it from the server's own description when you leave it empty."
      >
        <Textarea
          id={`${prefix}-description`}
          name="description"
          defaultValue={initial.description}
          maxLength={1000}
          placeholder="Code hosting: repositories, issues and pull requests on GitHub."
        />
      </Field>

      <Field label="Authentication" htmlFor={`${prefix}-auth`}>
        <Select
          id={`${prefix}-auth`}
          name="authType"
          value={authType}
          onChange={(event) => setAuthType(event.target.value as AuthType)}
        >
          <option value="none">None — the server is open</option>
          <option value="header">
            Secret in a header — an API key or personal token
          </option>
          <option value="oauth">OAuth — sign in to the server from PCP</option>
        </Select>
      </Field>

      {authType === "header" ? (
        <HeaderAuthFields prefix={prefix} secrets={secrets} initial={initial} />
      ) : null}

      {authType === "oauth" && !editing ? (
        <>
          <p className="-mt-2 text-xs leading-relaxed text-muted-foreground">
            After adding it, choose <strong>Connect</strong> on the
            server&apos;s page to sign in. PCP registers itself with the server
            when the server allows it.
          </p>
          <Disclosure
            title="More options"
            description="Your own OAuth client, its scope and extra sign-in parameters"
            className="bg-field"
          >
            {oauthFields}
          </Disclosure>
        </>
      ) : (
        oauthFields
      )}

      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
      <div>
        <SubmitButton pendingText={editing ? "Saving…" : "Adding…"}>
          {editing ? "Save changes" : "Add server"}
        </SubmitButton>
      </div>
    </form>
  )

  // Editing, the form is already inside the page's Advanced panel.
  return editing ? form : <Card className="p-6">{form}</Card>
}
