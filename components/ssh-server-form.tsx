"use client"

import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Card, CardContent } from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
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
 * once it exists. Fields are held in state so a refused submit keeps what
 * was typed.
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
              placeholder="Build box"
            />
          </Field>
          {editing ? (
            <Field
              label="Short name"
              htmlFor={`${prefix}-slug`}
              hint="How an assistant refers to this server in tool calls (server/tool). Lowercase letters, digits and dashes."
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
            hint="What this machine is and what an assistant may do there, in a sentence. An assistant reads this to choose a server."
          >
            <Textarea
              id={`${prefix}-description`}
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={1000}
              placeholder="The CI runner; logs are in /var/log/ci."
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem_1fr]">
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
              />
            </Field>
            <Field label="Port" htmlFor={`${prefix}-port`}>
              <Input
                id={`${prefix}-port`}
                name="port"
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                pattern="[0-9]{1,5}"
                placeholder="22"
              />
            </Field>
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
              />
            </Field>
          </div>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText={editing ? "Saving…" : "Adding…"}>
              {editing ? "Save changes" : "Add SSH server"}
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
