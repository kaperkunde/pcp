"use client"

import { useState } from "react"

import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { MAX_SECRET_VALUE, NEW_SECRET_CHOICE } from "@/lib/core/constants"

export type SecretOption = { id: string; name: string }

export type HeaderAuthValues = {
  authSecretId: string
  authHeaderName: string
  authValueTemplate: string
}

/**
 * "Send this secret in this header", shared by the server and endpoint
 * forms. The secret is one already stored, or one typed here that PCP
 * stores (encrypted, named after the server) when the form is saved, so
 * adding a server never means a detour through Secrets first. The values
 * are held in state: React resets an uncontrolled form after every action,
 * a failed one included, which would empty these fields each time a submit
 * is refused.
 */
export function HeaderAuthFields({
  prefix,
  secrets,
  initial,
}: {
  prefix: string
  secrets: SecretOption[]
  initial: HeaderAuthValues
}) {
  const [secretId, setSecretId] = useState(
    initial.authSecretId || (secrets.length === 0 ? NEW_SECRET_CHOICE : ""),
  )
  const [value, setValue] = useState("")
  const [header, setHeader] = useState(initial.authHeaderName)
  const [template, setTemplate] = useState(initial.authValueTemplate)

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <Field
        label="Secret"
        htmlFor={`${prefix}-secret`}
        hint="Stored encrypted; PCP sends it, the assistant never sees it."
      >
        <Select
          id={`${prefix}-secret`}
          name="authSecretId"
          value={secretId}
          onChange={(event) => setSecretId(event.target.value)}
          required
        >
          <option value="">Choose a secret…</option>
          <option value={NEW_SECRET_CHOICE}>Enter a new secret…</option>
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name}
            </option>
          ))}
        </Select>
      </Field>
      {secretId === NEW_SECRET_CHOICE ? (
        <Field
          label="Secret value"
          htmlFor={`${prefix}-secret-value`}
          hint="The API key or token. Saving stores it under Secrets, named after this server, where you can rename or change it later."
        >
          <Input
            id={`${prefix}-secret-value`}
            name="authSecretValue"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            maxLength={MAX_SECRET_VALUE}
            required
          />
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Header" htmlFor={`${prefix}-header`}>
          <Input
            id={`${prefix}-header`}
            name="authHeaderName"
            value={header}
            onChange={(event) => setHeader(event.target.value)}
            pattern="[A-Za-z0-9-]+"
            required
          />
        </Field>
        <Field
          label="Value"
          htmlFor={`${prefix}-template`}
          hint="{{secret}} is replaced by the secret."
        >
          <Input
            id={`${prefix}-template`}
            name="authValueTemplate"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            required
          />
        </Field>
      </div>
    </div>
  )
}
