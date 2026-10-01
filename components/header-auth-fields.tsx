"use client"

import { useState } from "react"

import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { NEW_SECRET } from "@/lib/core/constants"

export type SecretOption = { id: string; name: string }

export type HeaderAuthValues = {
  authSecretId: string
  authHeaderName: string
  authValueTemplate: string
}

/**
 * "Send this secret in this header", shared by the server and endpoint
 * forms. The secret is one of the owner's, or typed in here and saved as a
 * new one with the form (NEW_SECRET), so adding a server never means a trip
 * to the Secrets page first. The values are held in state: React resets an
 * uncontrolled form after every action, a failed one included, which would
 * empty these fields each time a submit is refused.
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
    initial.authSecretId || (secrets.length === 0 ? NEW_SECRET : ""),
  )
  const [newName, setNewName] = useState("")
  const [newValue, setNewValue] = useState("")
  const [header, setHeader] = useState(initial.authHeaderName)
  const [template, setTemplate] = useState(initial.authValueTemplate)
  const typingNew = secretId === NEW_SECRET

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <Field
        label="Secret"
        htmlFor={`${prefix}-secret`}
        hint={
          typingNew
            ? "Saved under Secrets with the form, where you can rotate it later."
            : "Stored encrypted; PCP sends it, an assistant never sees it."
        }
      >
        <Select
          id={`${prefix}-secret`}
          name="authSecretId"
          value={secretId}
          onChange={(event) => setSecretId(event.target.value)}
          required
        >
          <option value="">Choose a secret…</option>
          <option value={NEW_SECRET}>A new secret, entered here</option>
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name}
            </option>
          ))}
        </Select>
      </Field>
      {typingNew ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="New secret's value"
            htmlFor={`${prefix}-secret-value`}
            hint="The key or token itself. PCP sends it; an assistant never sees it."
          >
            <Input
              id={`${prefix}-secret-value`}
              name="authSecretValue"
              type="password"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <Field
            label="Save it as (optional)"
            htmlFor={`${prefix}-secret-name`}
            hint="Left empty, it is named after this server."
          >
            <Input
              id={`${prefix}-secret-name`}
              name="authSecretName"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </Field>
        </div>
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
