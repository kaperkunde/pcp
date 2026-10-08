"use client"

import { Plus } from "lucide-react"
import { useRef, useState, type ReactNode } from "react"

import {
  SecretChoice,
  type SecretOption,
} from "@/components/auth-fields-secret"
import { Button } from "@/components/ui/button"
import { Disclosure } from "@/components/ui/disclosure"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { MAX_AUTH_HEADERS, SECRET_PLACEHOLDER } from "@/lib/core/constants"

export type { SecretOption }

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
 * forms. The secret is one of the owner's, or typed in here and saved as a
 * new one with the form (NEW_SECRET), so adding a server never means a trip
 * to the Secrets page first. Further headers, each with a stored secret, are
 * for an API that wants several at once (a key and a secret key). The values
 * are held in state: React resets an uncontrolled form after every action, a
 * failed one included, which would empty these fields each time a submit is
 * refused.
 *
 * With `foldHeader` the header's name and format, and any further headers,
 * sit under a fold that says what is sent: most APIs take the default.
 */
export function HeaderAuthFields({
  prefix,
  secrets,
  initial,
  foldHeader = false,
}: {
  prefix: string
  secrets: SecretOption[]
  initial: HeaderAuthValues
  foldHeader?: boolean
}) {
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

  const headerFields: ReactNode = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Header" htmlFor={`${prefix}-header`}>
          <Input
            id={`${prefix}-header`}
            name="authHeaderName"
            value={header}
            onChange={(event) => setHeader(event.target.value)}
            pattern="[A-Za-z0-9-]+"
            required
            spellCheck={false}
            className="font-mono"
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
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </div>
      {extras.map((extra, index) => {
        const id = `${prefix}-extra-${extra.key}`
        // Numbered after the first header, which is the unnumbered one.
        const n = index + 2

        return (
          <fieldset
            key={extra.key}
            className="m-0 flex min-w-0 flex-col gap-4 border-0 border-t border-separator p-0 pt-4"
          >
            <legend className="sr-only">Secret header {n}</legend>
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
                  spellCheck={false}
                  className="font-mono"
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
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="self-start"
              onClick={() =>
                setExtras((current) =>
                  current.filter((other) => other.key !== extra.key),
                )
              }
            >
              Remove header {n}
            </Button>
          </fieldset>
        )
      })}
      {extras.length + 1 < MAX_AUTH_HEADERS ? (
        <div className="flex flex-col items-start gap-1">
          <Button
            type="button"
            variant="secondary"
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
            <Plus aria-hidden />
            Add another secret header
          </Button>
          <p className="text-xs text-muted-foreground">
            For an API that wants several secrets at once, such as a key and a
            secret key, each in its own header. Further headers send secrets
            stored under Secrets.
          </p>
        </div>
      ) : null}
    </>
  )

  return (
    <div className="flex flex-col gap-4">
      <SecretChoice
        prefix={prefix}
        label="Secret"
        secrets={secrets}
        initialId={initial.authSecretId}
        typeNew={{
          option: "A new secret, entered here",
          valueLabel: "New secret's value",
          valueHint:
            "The key or token itself. PCP sends it; an assistant never sees it.",
          nameHint: "Left empty, it is named after this server.",
        }}
      />
      {foldHeader ? (
        <Disclosure
          title="Header and format"
          description={
            <>
              Sent as{" "}
              <code className="text-foreground">
                {header || "…"}: {template}
              </code>
              {extras.length > 0
                ? `, and ${extras.length} more header${extras.length === 1 ? "" : "s"}`
                : null}
              . Change it if the API wants another header or format.
            </>
          }
          defaultOpen={initial.authExtraHeaders.length > 0}
          className="rounded-[10px] border border-input bg-field"
        >
          {headerFields}
        </Disclosure>
      ) : (
        headerFields
      )}
    </div>
  )
}
