"use client"

import { useState } from "react"

import { SecretChoice } from "@/components/auth-fields-secret"
import type { SecretOption } from "@/components/header-auth-fields"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"

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

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="User name"
        htmlFor={`${prefix}-username`}
        hint="Sent with the password as HTTP Basic authentication, in the Authorization header of every call to the base URL."
      >
        <Input
          id={`${prefix}-username`}
          name="authUsername"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
          autoComplete="off"
        />
      </Field>
      <SecretChoice
        prefix={prefix}
        label="Password"
        secrets={secrets}
        initialId={initial.authSecretId}
        typeNew={{
          option: "A new password, entered here",
          valueLabel: "New password",
          valueHint:
            "PCP sends it with the user name; an assistant never sees it.",
          nameHint: "Left empty, it is named after this endpoint.",
        }}
      />
    </div>
  )
}
