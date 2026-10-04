"use client"

import { useState, type ReactNode } from "react"

import { CopyableValue } from "@/components/copyable-value"
import type { SecretOption } from "@/components/header-auth-fields"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"

export type OAuthClientValues = {
  oauthClientId: string
  oauthClientSecretId: string
  oauthScope: string
  oauthAuthorizeParams: string
}

/**
 * "Sign in from PCP", shared by the server and mail account forms: the
 * redirect address to give a provider, and the owner's own client when the
 * provider lets no app register itself. The values are held in state, as in
 * HeaderAuthFields, so a refused submit does not empty them.
 */
export function OAuthClientFields({
  prefix,
  secrets,
  initial,
  redirectUrl,
  intro,
  scopeHint = "Leave empty to let the server decide.",
}: {
  prefix: string
  secrets: SecretOption[]
  initial: OAuthClientValues
  redirectUrl: string
  /** What to tell the owner first; the server form's wording by default. */
  intro?: ReactNode
  scopeHint?: ReactNode
}) {
  const [clientId, setClientId] = useState(initial.oauthClientId)
  const [clientSecretId, setClientSecretId] = useState(
    initial.oauthClientSecretId,
  )
  const [clientSecretValue, setClientSecretValue] = useState("")
  const [scope, setScope] = useState(initial.oauthScope)
  const [authorizeParams, setAuthorizeParams] = useState(
    initial.oauthAuthorizeParams,
  )

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <p className="text-muted-foreground">
        {intro ?? (
          <>
            After saving, choose <strong>Connect</strong> on the server page to
            sign in. PCP registers itself with the server when the server allows
            it. When it does not, create an OAuth client in the provider&apos;s
            developer settings with this redirect URI, and enter its client ID
            and secret here:
          </>
        )}
      </p>
      <CopyableValue value={redirectUrl} testId="oauth-redirect-url" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client ID (optional)" htmlFor={`${prefix}-client-id`}>
          <Input
            id={`${prefix}-client-id`}
            name="oauthClientId"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
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
            value={clientSecretId}
            onChange={(event) => setClientSecretId(event.target.value)}
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
          value={clientSecretValue}
          onChange={(event) => setClientSecretValue(event.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field
        label="Scope (optional)"
        htmlFor={`${prefix}-scope`}
        hint={scopeHint}
      >
        <Input
          id={`${prefix}-scope`}
          name="oauthScope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
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
          value={authorizeParams}
          onChange={(event) => setAuthorizeParams(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    </div>
  )
}
