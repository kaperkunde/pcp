"use client"

import { useActionState, useMemo, useState } from "react"

import {
  FormFooter,
  FormSection,
  NameFields,
  ServerFormFrame,
} from "@/components/server-form-parts"
import { Input, Select, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  launchServiceAction,
  saveServiceSettingsAction,
} from "@/lib/actions/services"

/**
 * Launching a service, and its settings once it runs. The definition is
 * JSON (what the service is: its image by digest, ports, variables,
 * volumes, health check and what it registers); the form reads its ports
 * and variables from it as it is typed, for the SSH server's ports and the
 * secret each variable takes. PCP checks all of it again on its side.
 */

type Option = { id: string; name: string }

type Variable = { name: string; required: boolean; description: string }

export const EXAMPLE_DEFINITION = JSON.stringify(
  {
    image: "ghcr.io/docling-project/docling-serve@sha256:<64 hex digits>",
    source: "ghcr.io/docling-project/docling-serve:latest",
    ports: [{ container: 5001 }],
    env: [
      {
        name: "DOCLING_SERVE_API_KEY",
        required: true,
        description: "The key the API asks for.",
      },
    ],
    volumes: [{ name: "models", path: "/opt/app-root/src/.cache" }],
    health: { kind: "http", port: 5001, path: "/health" },
    registers: {
      kind: "openapi",
      port: 5001,
      specPath: "/openapi.json",
      auth: {
        env: "DOCLING_SERVE_API_KEY",
        header: "X-Api-Key",
        template: "{{secret}}",
      },
    },
  },
  null,
  2,
)

/** The ports and variables a definition names, as far as it reads. */
function readShape(text: string): {
  ports: number[]
  env: Variable[]
  problem: string | null
} {
  try {
    const value = JSON.parse(text) as {
      ports?: Array<{ container?: unknown }>
      env?: Array<{ name?: unknown; required?: unknown; description?: unknown }>
    }

    return {
      ports: (value.ports ?? [])
        .map((port) => port.container)
        .filter((port): port is number => typeof port === "number"),
      env: (value.env ?? [])
        .filter((entry) => typeof entry.name === "string")
        .map((entry) => ({
          name: entry.name as string,
          required: entry.required === true,
          description:
            typeof entry.description === "string" ? entry.description : "",
        })),
      problem: null,
    }
  } catch {
    return { ports: [], env: [], problem: "The definition is not JSON yet." }
  }
}

function SecretSelect({
  variable,
  secrets,
  value,
  onChange,
}: {
  variable: Variable
  secrets: Option[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field
      label={variable.name}
      htmlFor={`service-env-${variable.name}`}
      hint={
        variable.description ||
        (variable.required ? "The service needs it." : undefined)
      }
    >
      <Select
        id={`service-env-${variable.name}`}
        name={`env.${variable.name}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={variable.required}
      >
        <option value="">
          {variable.required ? "Choose a secret" : "None (or its fixed value)"}
        </option>
        {secrets.map((secret) => (
          <option key={secret.id} value={secret.id}>
            {secret.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

export function ServiceLaunchForm({
  hosts,
  secrets,
}: {
  /** The SSH servers whose host key PCP has pinned. */
  hosts: Array<Option & { address: string }>
  secrets: Option[]
}) {
  const [state, action] = useActionState<ServerActionResult, FormData>(
    launchServiceAction,
    { status: "idle" },
  )
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [description, setDescription] = useState("")
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "")
  const [definition, setDefinition] = useState(EXAMPLE_DEFINITION)
  const [address, setAddress] = useState("0.0.0.0")
  const [hostPorts, setHostPorts] = useState<Record<number, string>>({})
  const [env, setEnv] = useState<Record<string, string>>({})
  const shape = useMemo(() => readShape(definition), [definition])

  return (
    <ServerFormFrame editing={false} action={action}>
      <FormSection>
        <NameFields
          prefix="service-new"
          editing={false}
          name={name}
          onNameChange={setName}
          slug={slug}
          onSlugChange={setSlug}
          description={description}
          onDescriptionChange={setDescription}
          namePlaceholder="Docling"
          descriptionPlaceholder="Turns PDFs and images into Markdown."
          descriptionHint="What it does, in a sentence: the server it serves carries it, and assistants read it to choose a tool."
          slugHint="How an assistant refers to the server it serves."
        />
      </FormSection>
      <FormSection title="Where it runs">
        <Field
          label="SSH server"
          htmlFor="service-host"
          hint="Docker or Podman must already be installed there for the login PCP uses. PCP only runs it through its command line."
        >
          <Select
            id="service-host"
            name="hostId"
            value={hostId}
            onChange={(event) => setHostId(event.target.value)}
            required
          >
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name} ({host.address})
              </option>
            ))}
          </Select>
        </Field>
      </FormSection>
      <FormSection title="What it is">
        <Field
          label="Definition"
          htmlFor="service-definition"
          hint="JSON: the image pinned by digest (repository@sha256:…), its ports, the names of its variables, named volumes (never a folder of the server), a health check, and what PCP adds for it: an API endpoint from its schema (openapi), an MCP server (mcp), or nothing (none)."
        >
          <Textarea
            id="service-definition"
            name="definition"
            value={definition}
            onChange={(event) => setDefinition(event.target.value)}
            spellCheck={false}
            className="min-h-72 font-mono text-xs"
            required
          />
        </Field>
        {shape.problem ? (
          <p className="text-xs text-muted-foreground">{shape.problem}</p>
        ) : null}
      </FormSection>
      {shape.ports.length > 0 ? (
        <FormSection title="Ports">
          <Field
            label="Publish on"
            htmlFor="service-address"
            hint="The SSH server's address the ports listen on: 0.0.0.0 for every address, or one of its own. PCP reaches what the service serves there; 127.0.0.1 works only when PCP runs on that machine."
          >
            <Input
              id="service-address"
              name="address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              spellCheck={false}
              className="font-mono"
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {shape.ports.map((port) => (
              <Field
                key={port}
                label={`The SSH server's port for ${port}`}
                htmlFor={`service-port-${port}`}
              >
                <input type="hidden" name="port.container" value={port} />
                <Input
                  id={`service-port-${port}`}
                  name="port.host"
                  inputMode="numeric"
                  pattern="[0-9]{1,5}"
                  value={hostPorts[port] ?? String(port)}
                  onChange={(event) =>
                    setHostPorts({ ...hostPorts, [port]: event.target.value })
                  }
                  className="font-mono"
                  required
                />
              </Field>
            ))}
          </div>
        </FormSection>
      ) : (
        <input type="hidden" name="address" value={address} />
      )}
      {shape.env.length > 0 ? (
        <FormSection title="Secrets for its variables">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Each value goes to the engine over the SSH connection&apos;s
            standard input, never on a command line, and assistants never see
            it. Changing a secret later restarts the service with the new value.
          </p>
          {shape.env.map((variable) => (
            <SecretSelect
              key={variable.name}
              variable={variable}
              secrets={secrets}
              value={env[variable.name] ?? ""}
              onChange={(value) => setEnv({ ...env, [variable.name]: value })}
            />
          ))}
        </FormSection>
      ) : null}
      <FormFooter
        editing={false}
        state={state}
        submitLabel="Launch"
        pendingText="Launching…"
      />
    </ServerFormFrame>
  )
}

export function ServiceSettingsForm({
  initial,
  variables,
  secrets,
}: {
  initial: {
    id: string
    name: string
    slug: string
    description: string
    env: Record<string, string>
  }
  variables: Variable[]
  secrets: Option[]
}) {
  const [state, action] = useActionState<ServerActionResult, FormData>(
    saveServiceSettingsAction,
    { status: "idle" },
  )
  const [name, setName] = useState(initial.name)
  const [slug, setSlug] = useState(initial.slug)
  const [description, setDescription] = useState(initial.description)
  const [env, setEnv] = useState(initial.env)

  return (
    <ServerFormFrame editing action={action}>
      <input type="hidden" name="id" value={initial.id} />
      <FormSection>
        <NameFields
          prefix={`service-${initial.id}`}
          editing
          name={name}
          onNameChange={setName}
          slug={slug}
          onSlugChange={setSlug}
          description={description}
          onDescriptionChange={setDescription}
          namePlaceholder="Docling service"
          descriptionHint="What it does, in a sentence."
          slugHint="How an assistant refers to the service's own tools (status, logs, start, stop, restart)."
        />
      </FormSection>
      {variables.length > 0 ? (
        <FormSection title="Secrets for its variables">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Another secret here restarts the service with it.
          </p>
          {variables.map((variable) => (
            <SecretSelect
              key={variable.name}
              variable={variable}
              secrets={secrets}
              value={env[variable.name] ?? ""}
              onChange={(value) => setEnv({ ...env, [variable.name]: value })}
            />
          ))}
        </FormSection>
      ) : null}
      <FormFooter
        editing
        state={state}
        submitLabel="Save"
        pendingText="Saving…"
      />
    </ServerFormFrame>
  )
}
