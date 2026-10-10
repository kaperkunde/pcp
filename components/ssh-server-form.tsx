"use client"

import { useActionState, useState } from "react"

import {
  FormFooter,
  FormSection,
  MoreOptions,
  NameFields,
  ServerFormFrame,
} from "@/components/server-form-parts"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  createSshServerAction,
  updateSshServerAction,
} from "@/lib/actions/ssh-servers"

export type SshServerFormValues = {
  id?: string
  name: string
  slug?: string
  description: string
  host: string
  port: string
  username: string
}

export const EMPTY_SSH_SERVER: SshServerFormValues = {
  name: "",
  description: "",
  host: "",
  port: "22",
  username: "",
}

/**
 * Add or edit an SSH server: where it is and the login. PCP's own key, to
 * add on the server, and the host key it pinned are on the server's page
 * once it exists. Adding, the port (22 unless changed) is under "More
 * options". Fields are held in state so a refused submit keeps what was
 * typed.
 */
export function SshServerForm({ initial }: { initial: SshServerFormValues }) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing ? updateSshServerAction : createSshServerAction,
    { status: "idle" },
  )
  const prefix = editing ? `ssh-${initial.id}` : "ssh-new"

  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(initial.slug ?? "")
  const [description, setDescription] = useState(initial.description)
  const [host, setHost] = useState(initial.host)
  const [port, setPort] = useState(initial.port)
  const [username, setUsername] = useState(initial.username)
  const [moreOpen] = useState(() =>
    Boolean(initial.port && initial.port !== "22"),
  )

  const portField = (
    <Field
      label="Port"
      htmlFor={`${prefix}-port`}
      hint={
        editing
          ? undefined
          : "Leave it at 22 unless the server listens on another port."
      }
    >
      <Input
        id={`${prefix}-port`}
        name="port"
        inputMode="numeric"
        value={port}
        onChange={(event) => setPort(event.target.value)}
        pattern="[0-9]{1,5}"
        placeholder="22"
        className="font-mono"
      />
    </Field>
  )

  const hostField = (
    <Field label="Host" htmlFor={`${prefix}-host`}>
      <Input
        id={`${prefix}-host`}
        name="host"
        value={host}
        onChange={(event) => setHost(event.target.value)}
        required
        spellCheck={false}
        autoComplete="off"
        placeholder="build.example.com"
        className="font-mono"
      />
    </Field>
  )

  const loginField = (
    <Field
      label="Login"
      htmlFor={`${prefix}-username`}
      hint="The account PCP's key goes in."
    >
      <Input
        id={`${prefix}-username`}
        name="username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        required
        spellCheck={false}
        autoComplete="off"
        placeholder="deploy"
        className="font-mono"
      />
    </Field>
  )

  return (
    <ServerFormFrame editing={editing} action={action}>
      {editing ? <input type="hidden" name="id" value={initial.id} /> : null}
      <FormSection>
        <NameFields
          prefix={prefix}
          editing={editing}
          name={name}
          onNameChange={setName}
          slug={slug}
          onSlugChange={setSlug}
          description={description}
          onDescriptionChange={setDescription}
          namePlaceholder="Build box"
          descriptionPlaceholder="The CI runner; logs are in /var/log/ci."
          descriptionHint="What this machine is and what an assistant may do there, in a sentence. An assistant reads this to choose a server."
          slugHint="How an assistant refers to this server in tool calls (server/tool). Lowercase letters, digits and dashes."
        />
      </FormSection>
      <FormSection>
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem_1fr]">
            {hostField}
            {portField}
            {loginField}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {hostField}
            {loginField}
          </div>
        )}
      </FormSection>
      {editing ? null : (
        <MoreOptions
          description="The port, 22 unless you change it."
          defaultOpen={moreOpen}
        >
          {portField}
        </MoreOptions>
      )}
      <FormFooter
        editing={editing}
        state={state}
        submitLabel="Add SSH server"
        pendingText={editing ? "Saving…" : "Adding…"}
      />
    </ServerFormFrame>
  )
}
