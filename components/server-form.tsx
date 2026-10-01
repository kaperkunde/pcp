"use client"

import { useActionState, useState } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import {
  HeaderAuthFields,
  type SecretOption,
} from "@/components/header-auth-fields"
import { SubmitButton } from "@/components/submit-button"
import { Card, CardContent } from "@/components/ui/card"
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
  oauthClientId: "",
  oauthClientSecretId: "",
  oauthScope: "",
  oauthAuthorizeParams: "",
}

/**
 * Add or edit a server. Mirrors what an assistant's own "add connector"
 * dialog asks for — name, URL, and how to authenticate — with PCP's own
 * secrets as the values, never the values themselves.
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

  return (
    <Card>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {editing ? (
            <input type="hidden" name="id" value={initial.id} />
          ) : null}

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
              <option value="oauth">
                OAuth — sign in to the server from PCP
              </option>
            </Select>
          </Field>

          {authType === "header" ? (
            <HeaderAuthFields
              prefix={prefix}
              secrets={secrets}
              initial={initial}
            />
          ) : null}

          {authType === "oauth" ? (
            <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
              <p className="text-muted-foreground">
                After saving, choose <strong>Connect</strong> on the server page
                to sign in. PCP registers itself with the server when the server
                allows it. When it does not, create an OAuth client in the
                provider&apos;s developer settings with this redirect URI, and
                enter its client ID and secret here:
              </p>
              <CopyableValue value={redirectUrl} testId="oauth-redirect-url" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Client ID (optional)"
                  htmlFor={`${prefix}-client-id`}
                >
                  <Input
                    id={`${prefix}-client-id`}
                    name="oauthClientId"
                    defaultValue={initial.oauthClientId}
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Client secret (optional)"
                  htmlFor={`${prefix}-client-secret`}
                  hint="A secret holding it, or paste it below."
                >
                  <Select
                    id={`${prefix}-client-secret`}
                    name="oauthClientSecretId"
                    defaultValue={initial.oauthClientSecretId}
                  >
                    <option value="">None</option>
                    {secrets.map((secret) => (
                      <option key={secret.id} value={secret.id}>
                        {secret.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field
                label="New client secret (optional)"
                htmlFor={`${prefix}-client-secret-value`}
                hint="Saved as a new secret, which you can pick for another server that uses the same client."
              >
                <Input
                  id={`${prefix}-client-secret-value`}
                  name="oauthClientSecretValue"
                  type="password"
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Scope (optional)"
                htmlFor={`${prefix}-scope`}
                hint="Leave empty to let the server decide."
              >
                <Input
                  id={`${prefix}-scope`}
                  name="oauthScope"
                  defaultValue={initial.oauthScope}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Extra sign-in parameters (optional)"
                htmlFor={`${prefix}-authorize-params`}
                hint="Added to the sign-in address, like access_type=offline&prompt=consent. Some servers only let PCP stay signed in when the sign-in asks for it; the server's documentation says which."
              >
                <Input
                  id={`${prefix}-authorize-params`}
                  name="oauthAuthorizeParams"
                  defaultValue={initial.oauthAuthorizeParams}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </div>
          ) : null}

          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText={editing ? "Saving…" : "Adding…"}>
              {editing ? "Save changes" : "Add server"}
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
