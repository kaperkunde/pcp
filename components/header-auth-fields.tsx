"use client"

import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { MAX_AUTH_HEADERS, SECRET_PLACEHOLDER } from "@/lib/core/constants"

export type SecretOption = { id: string; name: string }

export type ExtraHeaderValues = {
  secretId: string
  headerName: string
  valueTemplate: string
}

export type HeaderAuthValues = {
  authSecretId: string
  authHeaderName: string
  authValueTemplate: string
  /** Headers sent with the first, each with its own secret. */
  authExtraHeaders: ExtraHeaderValues[]
}

/**
 * "Send this secret in this header", shared by the server and endpoint
 * forms, with further headers for an API that wants several secrets at once
 * (a key and a secret key). The values are held in state: React resets an
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
  const [secretId, setSecretId] = useState(initial.authSecretId)
  const [header, setHeader] = useState(initial.authHeaderName)
  const [template, setTemplate] = useState(initial.authValueTemplate)
  const nextKey = useRef(initial.authExtraHeaders.length)
  const [extras, setExtras] = useState(
    initial.authExtraHeaders.map((extra, key) => ({ ...extra, key })),
  )

  const changeExtra = (key: number, change: Partial<ExtraHeaderValues>) =>
    setExtras((current) =>
      current.map((extra) =>
        extra.key === key ? { ...extra, ...change } : extra,
      ),
    )

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <Field
        label="Secret"
        htmlFor={`${prefix}-secret`}
        hint={
          secrets.length === 0
            ? "Add the key under Secrets first, then pick it here."
            : "Stored encrypted; PCP sends it, the assistant never sees it."
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
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name}
            </option>
          ))}
        </Select>
      </Field>
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
      {extras.map((extra, index) => {
        const id = `${prefix}-extra-${extra.key}`
        // Numbered after the first header, which is the unnumbered one.
        const n = index + 2

        return (
          <div
            key={extra.key}
            className="flex flex-col gap-4 border-t border-border pt-4"
          >
            <Field label={`Secret ${n}`} htmlFor={`${id}-secret`}>
              <Select
                id={`${id}-secret`}
                name="authExtraSecretId"
                value={extra.secretId}
                onChange={(event) =>
                  changeExtra(extra.key, { secretId: event.target.value })
                }
                required
              >
                <option value="">Choose a secret…</option>
                {secrets.map((secret) => (
                  <option key={secret.id} value={secret.id}>
                    {secret.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`Header ${n}`} htmlFor={`${id}-header`}>
                <Input
                  id={`${id}-header`}
                  name="authExtraHeaderName"
                  value={extra.headerName}
                  onChange={(event) =>
                    changeExtra(extra.key, { headerName: event.target.value })
                  }
                  pattern="[A-Za-z0-9-]+"
                  required
                />
              </Field>
              <Field label={`Value ${n}`} htmlFor={`${id}-template`}>
                <Input
                  id={`${id}-template`}
                  name="authExtraValueTemplate"
                  value={extra.valueTemplate}
                  onChange={(event) =>
                    changeExtra(extra.key, {
                      valueTemplate: event.target.value,
                    })
                  }
                  required
                />
              </Field>
            </div>
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setExtras((current) =>
                    current.filter((other) => other.key !== extra.key),
                  )
                }
              >
                Remove header {n}
              </Button>
            </div>
          </div>
        )
      })}
      {extras.length + 1 < MAX_AUTH_HEADERS ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setExtras((current) => [
                ...current,
                {
                  key: nextKey.current++,
                  secretId: "",
                  headerName: "",
                  valueTemplate: SECRET_PLACEHOLDER,
                },
              ])
            }
          >
            Add another secret header
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            For an API that wants several secrets at once, such as a key and a
            secret key, each in its own header.
          </p>
        </div>
      ) : null}
    </div>
  )
}
