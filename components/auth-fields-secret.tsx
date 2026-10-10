"use client"

import Link from "next/link"
import { useState } from "react"

import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { NEW_SECRET } from "@/lib/core/constants"

export type SecretOption = { id: string; name: string }

/**
 * Which of the owner's secrets a server sends (`authSecretId`): one they
 * hold, or, with `typeNew`, one typed in here and saved under Secrets with
 * the form (NEW_SECRET, with `authSecretValue` and `authSecretName`). PCP
 * sends it; an assistant never sees it. Held in its own state unless the
 * form holds it (`value`): React resets an uncontrolled form after every
 * action, a refused one included.
 */
export function SecretChoice({
  prefix,
  label,
  secrets,
  initialId = "",
  value,
  onValueChange,
  hint,
  typeNew,
}: {
  prefix: string
  label: string
  secrets: SecretOption[]
  initialId?: string
  value?: string
  onValueChange?: (value: string) => void
  /** Under the choice, for a secret already held. */
  hint?: string
  /** Offer a new secret typed in here, and how to word it. */
  typeNew?: {
    option: string
    valueLabel: string
    valueHint: string
    nameHint: string
  }
}) {
  const [ownId, setOwnId] = useState(
    initialId || (typeNew && secrets.length === 0 ? NEW_SECRET : ""),
  )
  const [newName, setNewName] = useState("")
  const [newValue, setNewValue] = useState("")
  const secretId = value ?? ownId
  const typingNew = Boolean(typeNew) && secretId === NEW_SECRET

  const choose = (next: string) => {
    setOwnId(next)
    onValueChange?.(next)
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label={label}
        htmlFor={`${prefix}-secret`}
        hint={
          typingNew ? (
            "Saved under Secrets with the form, where you can rotate it later."
          ) : secrets.length === 0 && !typeNew ? (
            <>
              Add it under{" "}
              <Link href="/secrets" className="text-primary hover:underline">
                Secrets
              </Link>{" "}
              first, then pick it here.
            </>
          ) : (
            `${hint ? `${hint} ` : ""}Stored encrypted; PCP sends it, an assistant never sees it.`
          )
        }
      >
        <Select
          id={`${prefix}-secret`}
          name="authSecretId"
          value={secretId}
          onChange={(event) => choose(event.target.value)}
          required
        >
          <option value="">Choose a secret…</option>
          {typeNew ? (
            <option value={NEW_SECRET}>{typeNew.option}</option>
          ) : null}
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name}
            </option>
          ))}
        </Select>
      </Field>
      {typeNew && typingNew ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={typeNew.valueLabel}
            htmlFor={`${prefix}-secret-value`}
            hint={typeNew.valueHint}
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
            hint={typeNew.nameHint}
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
    </div>
  )
}
