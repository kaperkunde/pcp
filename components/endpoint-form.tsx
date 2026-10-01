"use client"

import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import {
  HeaderAuthFields,
  type SecretOption,
} from "@/components/header-auth-fields"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import {
  createEndpointAction,
  updateEndpointAction,
} from "@/lib/actions/endpoints"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_VALUE_TEMPLATE,
  MAX_SPEC_BYTES,
  SPEC_FILE_ACCEPT,
} from "@/lib/core/constants"

export type EndpointFormValues = {
  id?: string
  name: string
  slug?: string
  description: string
  specSource: "url" | "upload"
  specUrl: string
  /** When editing: when PCP last read the schema. */
  specReadAt?: Date | null
  baseUrl: string
  readOnly: boolean
  /** Refuse private, local and link-local addresses. */
  publicOnly: boolean
  authType: "none" | "header"
  authHeaderName: string
  authValueTemplate: string
  authSecretId: string
}

export const EMPTY_ENDPOINT: EndpointFormValues = {
  name: "",
  description: "",
  specSource: "url",
  specUrl: "",
  baseUrl: "",
  readOnly: false,
  publicOnly: false,
  authType: "none",
  authHeaderName: DEFAULT_HEADER_NAME,
  authValueTemplate: DEFAULT_VALUE_TEMPLATE,
  authSecretId: "",
}

/**
 * Add or edit an API endpoint: an API described by an OpenAPI schema, read
 * from a URL or an uploaded file. Text fields are held in state because
 * React resets an uncontrolled form after every action, a refused one
 * included, and a schema that does not read is the likeliest refusal; a
 * chosen file cannot be kept, only the rest.
 */
export function EndpointForm({
  initial,
  secrets,
}: {
  initial: EndpointFormValues
  secrets: SecretOption[]
}) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing ? updateEndpointAction : createEndpointAction,
    { status: "idle" },
  )
  const prefix = editing ? `endpoint-${initial.id}` : "endpoint-new"

  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(initial.slug ?? "")
  const [description, setDescription] = useState(initial.description)
  const [specSource, setSpecSource] = useState(initial.specSource)
  const [specUrl, setSpecUrl] = useState(initial.specUrl)
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [readOnly, setReadOnly] = useState(initial.readOnly)
  const [publicOnly, setPublicOnly] = useState(initial.publicOnly)
  const [authType, setAuthType] = useState(initial.authType)

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
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
              placeholder="Petstore"
            />
          </Field>

          {editing ? (
            <Field
              label="Short name"
              htmlFor={`${prefix}-slug`}
              hint="How an assistant refers to this endpoint in tool calls (endpoint/tool). Lowercase letters, digits and dashes."
            >
              <Input
                id={`${prefix}-slug`}
                name="slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                pattern="[a-z0-9-]+"
                maxLength={40}
              />
            </Field>
          ) : null}

          <Field
            label="Description"
            htmlFor={`${prefix}-description`}
            hint="What this API is for, in a sentence or two. An assistant reads this to decide where to look for a tool; PCP fills it from the schema when you leave it empty."
          >
            <Textarea
              id={`${prefix}-description`}
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={1000}
              placeholder="Pet store inventory: list, add and remove pets."
            />
          </Field>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">Schema</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Label className="font-normal">
                <input
                  type="radio"
                  name="specSource"
                  value="url"
                  className="accent-primary"
                  checked={specSource === "url"}
                  onChange={() => setSpecSource("url")}
                />
                From a URL
              </Label>
              <Label className="font-normal">
                <input
                  type="radio"
                  name="specSource"
                  value="upload"
                  className="accent-primary"
                  checked={specSource === "upload"}
                  onChange={() => setSpecSource("upload")}
                />
                Upload a file
              </Label>
            </div>

            {editing ? (
              <p className="text-xs text-muted-foreground">
                {initial.specSource === "url" ? (
                  <>
                    Read from <code>{initial.specUrl}</code>
                  </>
                ) : (
                  "Uploaded as a file"
                )}
                {initial.specReadAt ? (
                  <>
                    {" "}
                    · read <LocalDate value={initial.specReadAt} />
                  </>
                ) : null}
                . Saving rebuilds the tools from PCP&apos;s copy of the schema.
              </p>
            ) : null}

            {specSource === "url" ? (
              <Field
                label="Schema URL"
                htmlFor={`${prefix}-spec-url`}
                hint="Where the OpenAPI document lives, e.g. https://api.example.com/openapi.json. PCP downloads it now and again whenever you re-read it."
              >
                <Input
                  id={`${prefix}-spec-url`}
                  name="specUrl"
                  type="url"
                  value={specUrl}
                  onChange={(event) => setSpecUrl(event.target.value)}
                  required
                  placeholder="https://"
                />
              </Field>
            ) : (
              <Field
                label="Schema file"
                htmlFor={`${prefix}-spec-file`}
                hint={`OpenAPI 3 as JSON or YAML, up to ${MAX_SPEC_BYTES / 1024 / 1024} MB.${editing ? " Choose a file to replace the stored schema; leave it empty to keep it." : ""}`}
              >
                <Input
                  id={`${prefix}-spec-file`}
                  name="specFile"
                  type="file"
                  accept={SPEC_FILE_ACCEPT}
                  required={!editing || initial.specSource !== "upload"}
                />
              </Field>
            )}
          </fieldset>

          <Field
            label="Base URL (optional)"
            htmlFor={`${prefix}-base-url`}
            hint="Where the API lives. Leave it empty to use the address in the schema. Once saved, PCP keeps this address even if the schema changes."
          >
            <Input
              id={`${prefix}-base-url`}
              name="baseUrl"
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </Field>

          <div className="flex flex-col gap-1.5">
            <Label className="font-normal" htmlFor={`${prefix}-read-only`}>
              <Checkbox
                id={`${prefix}-read-only`}
                name="readOnly"
                checked={readOnly}
                onChange={(event) => setReadOnly(event.target.checked)}
              />
              Read-only
            </Label>
            <p className="text-xs text-muted-foreground">
              Only operations that read (GET) become tools, so nothing an
              assistant calls here can change data.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="font-normal" htmlFor={`${prefix}-public-only`}>
              <Checkbox
                id={`${prefix}-public-only`}
                name="publicOnly"
                checked={publicOnly}
                onChange={(event) => setPublicOnly(event.target.checked)}
              />
              Public addresses only
            </Label>
            <p className="text-xs text-muted-foreground">
              Refuse private, local and link-local addresses, for the schema and
              for every call. On for endpoints an assistant registers; turn it
              off only for an API on your own network that you trust this
              endpoint to reach, or when this machine can only reach the
              internet through a proxy.
            </p>
          </div>

          <Field label="Authentication" htmlFor={`${prefix}-auth`}>
            <Select
              id={`${prefix}-auth`}
              name="authType"
              value={authType}
              onChange={(event) =>
                setAuthType(event.target.value as "none" | "header")
              }
            >
              <option value="none">None — the API is open</option>
              <option value="header">
                Secret in a header — an API key or token
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

          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText={editing ? "Saving…" : "Reading schema…"}>
              {editing ? "Save changes" : "Add endpoint"}
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
