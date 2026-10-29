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

type Variable = {
  name: string
  required: boolean
  description: string
  /** The owner types its value (no secret): a provider's name, a country. */
  plain: boolean
  /** Its fixed value, or a plain one's when none is typed. */
  value: string | null
}

/** The select's choice that types a new secret in on this form. */
const NEW_SECRET = "__new__"

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

/**
 * A VPN container as an exit, to start from: gluetun's shape (an HTTP proxy
 * with a login PCP makes, NET_ADMIN and the tunnel device). PCP's common
 * items have it whole, pinned by digest.
 */
const EXAMPLE_EXIT_DEFINITION = JSON.stringify(
  {
    image: "docker.io/qmcgaw/gluetun@sha256:<64 hex digits>",
    source: "docker.io/qmcgaw/gluetun:v3.41",
    ports: [{ container: 8888 }],
    env: [
      { name: "VPN_SERVICE_PROVIDER", plain: true, required: true },
      { name: "VPN_TYPE", plain: true, value: "openvpn" },
      { name: "SERVER_COUNTRIES", plain: true },
      { name: "OPENVPN_USER" },
      { name: "OPENVPN_PASSWORD" },
      { name: "HTTPPROXY", value: "on" },
    ],
    cap_add: ["NET_ADMIN"],
    devices: ["/dev/net/tun"],
    registers: {
      kind: "exit",
      port: 8888,
      protocol: "http",
      auth: { user_env: "HTTPPROXY_USER", password_env: "HTTPPROXY_PASSWORD" },
    },
  },
  null,
  2,
)

/** The ports and variables a definition names, as far as it reads. */
function readShape(text: string): {
  ports: number[]
  env: Variable[]
  /** It registers an exit: a VPN's proxy, on the SSH server's loopback. */
  exit: boolean
  problem: string | null
} {
  try {
    const value = JSON.parse(text) as {
      ports?: Array<{ container?: unknown }>
      env?: Array<{
        name?: unknown
        required?: unknown
        description?: unknown
        plain?: unknown
        value?: unknown
      }>
      registers?: { kind?: unknown }
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
          plain: entry.plain === true,
          value: typeof entry.value === "string" ? entry.value : null,
        })),
      exit: value.registers?.kind === "exit",
      problem: null,
    }
  } catch {
    return {
      ports: [],
      env: [],
      exit: false,
      problem: "The definition is not JSON yet.",
    }
  }
}

/** A plain variable's value, typed here: no secret. */
function PlainField({
  variable,
  value,
  onChange,
}: {
  variable: Variable
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field
      label={variable.name}
      htmlFor={`service-value-${variable.name}`}
      hint={
        variable.description ||
        (variable.required ? "The service needs it." : undefined)
      }
    >
      <Input
        id={`service-value-${variable.name}`}
        name={`value.${variable.name}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={variable.value ?? ""}
        required={variable.required && variable.value === null}
        maxLength={4000}
        spellCheck={false}
        autoComplete="off"
      />
    </Field>
  )
}

function SecretSelect({
  variable,
  secrets,
  value,
  onChange,
  allowNew = false,
}: {
  variable: Variable
  secrets: Option[]
  value: string
  onChange: (value: string) => void
  /** Offer to type a new secret in, saved in the vault with the launch. */
  allowNew?: boolean
}) {
  return (
    <>
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
            {variable.required
              ? "Choose a secret"
              : "None (or its fixed value)"}
          </option>
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name}
            </option>
          ))}
          {allowNew ? <option value={NEW_SECRET}>A new secret…</option> : null}
        </Select>
      </Field>
      {allowNew && value === NEW_SECRET ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="The new secret's name"
            htmlFor={`service-new-name-${variable.name}`}
          >
            <Input
              id={`service-new-name-${variable.name}`}
              name={`newSecret.${variable.name}.name`}
              required
              maxLength={100}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Its value"
            htmlFor={`service-new-value-${variable.name}`}
            hint="Saved in your vault, encrypted, with the launch."
          >
            <Input
              id={`service-new-value-${variable.name}`}
              name={`newSecret.${variable.name}.value`}
              type="password"
              required
              autoComplete="new-password"
            />
          </Field>
        </div>
      ) : null}
    </>
  )
}

export function ServiceLaunchForm({
  hosts,
  secrets,
  fixed,
  action: given,
  submitLabel = "Launch",
  defaultHostId,
  startFromExit = false,
}: {
  /** The SSH servers whose host key PCP has pinned. */
  hosts: Array<Option & { address: string }>
  secrets: Option[]
  /**
   * A definition the owner does not type: another instance of a service
   * (`definitionId`), or an item from a linked repository (the action reads
   * it again there). Shown whole, and not edited here.
   */
  fixed?: {
    /** The definition as JSON text, for the owner to read. */
    definition: string
    definitionId?: string
    name: string
    description: string
  }
  /** Another action than launching from a typed definition. */
  action?: (
    state: ServerActionResult,
    formData: FormData,
  ) => Promise<ServerActionResult>
  submitLabel?: string
  /** The SSH server chosen to start with (an exit added from its page). */
  defaultHostId?: string
  /** The owner starts typing from a VPN exit's definition. */
  startFromExit?: boolean
}) {
  const [state, action] = useActionState<ServerActionResult, FormData>(
    given ?? launchServiceAction,
    { status: "idle" },
  )
  const [name, setName] = useState(fixed?.name ?? "")
  const [slug, setSlug] = useState("")
  const [description, setDescription] = useState(fixed?.description ?? "")
  const [hostId, setHostId] = useState(
    hosts.find((host) => host.id === defaultHostId)?.id ?? hosts[0]?.id ?? "",
  )
  const [definition, setDefinition] = useState(
    fixed?.definition ??
      (startFromExit ? EXAMPLE_EXIT_DEFINITION : EXAMPLE_DEFINITION),
  )
  const [address, setAddress] = useState("0.0.0.0")
  const [hostPorts, setHostPorts] = useState<Record<number, string>>({})
  const [env, setEnv] = useState<Record<string, string>>({})
  const [values, setValues] = useState<Record<string, string>>({})
  const [exitName, setExitName] = useState("")
  const [exitLabel, setExitLabel] = useState("")
  const shape = useMemo(() => readShape(definition), [definition])
  const plain = shape.env.filter((variable) => variable.plain)
  const secretVariables = shape.env.filter((variable) => !variable.plain)

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
        {fixed ? (
          <>
            {fixed.definitionId ? (
              <input
                type="hidden"
                name="definitionId"
                value={fixed.definitionId}
              />
            ) : null}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Its definition, as it runs: the image pinned by digest, its ports,
              the names of its variables, its volumes, health check and what PCP
              adds for it.
            </p>
            <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
              {fixed.definition}
            </pre>
          </>
        ) : (
          <Field
            label="Definition"
            htmlFor="service-definition"
            hint="JSON: the image pinned by digest (repository@sha256:…), its ports, the names of its variables (plain ones are typed here, the rest take secrets), named volumes (never a folder of the server), a health check, and what PCP adds for it: an API endpoint from its schema (openapi), an MCP server (mcp), an exit from a VPN's proxy (exit, which alone may add NET_ADMIN and /dev/net/tun), or nothing (none)."
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
        )}
        {shape.problem ? (
          <p className="text-xs text-muted-foreground">{shape.problem}</p>
        ) : null}
      </FormSection>
      {shape.exit ? (
        <FormSection title="The exit">
          <p className="text-xs leading-relaxed text-muted-foreground">
            PCP adds this service&apos;s proxy as an exit: web fetch and the
            browser can then go out through the VPN, for the tokens you allow on
            their pages. Its port listens on the SSH server&apos;s own 127.0.0.1
            only, with a password PCP makes for it, and PCP reaches it through
            the SSH connection.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Exit name"
              htmlFor="service-exit-name"
              hint="What assistants name in their calls, like se-vpn."
            >
              <Input
                id="service-exit-name"
                name="exit.name"
                value={exitName}
                onChange={(event) => setExitName(event.target.value)}
                required
                maxLength={40}
                pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
              />
            </Field>
            <Field
              label="Where it comes out"
              htmlFor="service-exit-label"
              hint="Your words for it, like Sweden, Mullvad."
            >
              <Input
                id="service-exit-label"
                name="exit.label"
                value={exitLabel}
                onChange={(event) => setExitLabel(event.target.value)}
                maxLength={80}
                autoComplete="off"
              />
            </Field>
          </div>
        </FormSection>
      ) : null}
      {shape.ports.length > 0 ? (
        <FormSection title="Ports">
          {shape.exit ? (
            <input type="hidden" name="address" value="127.0.0.1" />
          ) : (
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
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {shape.ports.map((port) => (
              <Field
                key={port}
                label={
                  shape.exit
                    ? `The SSH server's loopback port for ${port}`
                    : `The SSH server's port for ${port}`
                }
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
        <input
          type="hidden"
          name="address"
          value={shape.exit ? "127.0.0.1" : address}
        />
      )}
      {plain.length > 0 ? (
        <FormSection title="Its settings">
          <p className="text-xs leading-relaxed text-muted-foreground">
            What you type here is no secret: it is kept with the service and
            shown on its page.
          </p>
          {plain.map((variable) => (
            <PlainField
              key={variable.name}
              variable={variable}
              value={values[variable.name] ?? ""}
              onChange={(value) =>
                setValues({ ...values, [variable.name]: value })
              }
            />
          ))}
        </FormSection>
      ) : null}
      {secretVariables.length > 0 ? (
        <FormSection title="Secrets for its variables">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Each value goes to the engine over the SSH connection&apos;s
            standard input, never on a command line, and assistants never see
            it. Changing a secret later restarts the service with the new value.
          </p>
          {secretVariables.map((variable) => (
            <SecretSelect
              key={variable.name}
              variable={variable}
              secrets={secrets}
              value={env[variable.name] ?? ""}
              onChange={(value) => setEnv({ ...env, [variable.name]: value })}
              allowNew
            />
          ))}
        </FormSection>
      ) : null}
      <FormFooter
        editing={false}
        state={state}
        submitLabel={submitLabel}
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
    /** What was typed for its plain variables. */
    values?: Record<string, string>
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
  const [values, setValues] = useState(initial.values ?? {})
  const plain = variables.filter((variable) => variable.plain)
  const secretVariables = variables.filter((variable) => !variable.plain)

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
      {plain.length > 0 ? (
        <FormSection title="Its settings">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Another value here restarts the service with it.
          </p>
          <input type="hidden" name="values" value="1" />
          {plain.map((variable) => (
            <PlainField
              key={variable.name}
              variable={variable}
              value={values[variable.name] ?? ""}
              onChange={(value) =>
                setValues({ ...values, [variable.name]: value })
              }
            />
          ))}
        </FormSection>
      ) : null}
      {secretVariables.length > 0 ? (
        <FormSection title="Secrets for its variables">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Another secret here restarts the service with it.
          </p>
          {secretVariables.map((variable) => (
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
