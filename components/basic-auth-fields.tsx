"use client"

import { useState } from "react"

import type { SecretOption } from "@/components/header-auth-fields"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { NEW_SECRET } from "@/lib/core/constants"

export type BasicAuthValues = {
  authUsername: string
  authSecretId: string
}

/**
 * "Sign in with this user name and password" (HTTP Basic authentication),
 * for an API endpoint. The password is one of the owner's secrets, or typed
 * in here and saved as a new one with the form (NEW_SECRET). The values are
 * held in state: React resets an uncontrolled form after every action, a
 * failed one included.
 */
export function BasicAuthFields({
  prefix,
  secrets,
  initial,
}: {
  prefix: string
  secrets: SecretOption[]
  initial: BasicAuthValues
}) {
  const [username, setUsername] = useState(initial.authUsername)
  const [secretId, setSecretId] = useState(
    initial.authSecretId || (secrets.length === 0 ? NEW_SECRET : ""),
  )
  const [newName, setNewName] = useState("")
  const [newValue, setNewValue] = useState("")
  const typingNew = secretId === NEW_SECRET

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="User name" htmlFor={`${prefix}-username`}>
          <Input
            id={`${prefix}-username`}
            name="authUsername"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            autoComplete="off"
          />
        </Field>
        <Field
          label="Password"
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
            <option value={NEW_SECRET}>A new password, entered here</option>
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {typingNew ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="New password"
            htmlFor={`${prefix}-secret-value`}
            hint="PCP sends it with the user name; an assistant never sees it."
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
            hint="Left empty, it is named after this endpoint."
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
      <p className="text-xs text-muted-foreground">
        Sent as HTTP Basic authentication in the Authorization header with every
        call, to the base URL.
      </p>
    </div>
  )
}
