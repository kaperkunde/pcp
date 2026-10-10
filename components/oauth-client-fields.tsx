"use client"

import type { ReactNode } from "react"

import { CopyableValue } from "@/components/copyable-value"
import type { SecretOption } from "@/components/header-auth-fields"
import { Disclosure } from "@/components/ui/disclosure"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"

export type OAuthClientValues = {
  oauthClientId: string
  oauthClientSecretId: string
  oauthScope: string
  oauthAuthorizeParams: string
}

/**
 * The OAuth part of the server, endpoint and mail forms: the redirect URI
 * to give the provider, the owner's client (its secret chosen from theirs
 * or typed in, saved as a new one), the scope and extra sign-in parameters.
 *
 * With `foldClient` the client, scope and parameters sit under a fold that
 * says when they are needed (most providers let PCP register itself); it
 * opens by itself when any of them is set.
 */
export function OAuthClientFields({
  prefix,
  secrets,
  initial,
  redirectUrl,
  intro,
  scopeHint,
  foldClient = false,
}: {
  prefix: string
  secrets: SecretOption[]
  initial: OAuthClientValues
  redirectUrl: string
  intro: ReactNode
  scopeHint: string
  foldClient?: boolean
}) {
  const clientFields = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client ID (optional)" htmlFor={`${prefix}-client-id`}>
          <Input
            id={`${prefix}-client-id`}
            name="oauthClientId"
            defaultValue={initial.oauthClientId}
            autoComplete="off"
            spellCheck={false}
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
        hint={scopeHint}
      >
        <Input
          id={`${prefix}-scope`}
          name="oauthScope"
          defaultValue={initial.oauthScope}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Extra sign-in parameters (optional)"
        htmlFor={`${prefix}-authorize-params`}
        hint="Added to the sign-in address, like access_type=offline&prompt=consent. Some servers only let PCP stay signed in when the sign-in asks for it; the server's documentation says which. PCP adds Google's itself."
      >
        <Input
          id={`${prefix}-authorize-params`}
          name="oauthAuthorizeParams"
          defaultValue={initial.oauthAuthorizeParams}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </Field>
    </>
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {intro}
      </p>
      <CopyableValue value={redirectUrl} testId="oauth-redirect-url" />
      {foldClient ? (
        <Disclosure
          title="Your own client, scope and sign-in parameters"
          description="Only for a provider that lets no app register itself, or that wants a scope or extra parameters."
          defaultOpen={Boolean(
            initial.oauthClientId ||
            initial.oauthClientSecretId ||
            initial.oauthScope ||
            initial.oauthAuthorizeParams,
          )}
          className="rounded-[10px] border border-input bg-field"
        >
          {clientFields}
        </Disclosure>
      ) : (
        clientFields
      )}
    </div>
  )
}
