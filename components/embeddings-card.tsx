"use client"

import { TextSearch } from "lucide-react"
import Link from "next/link"
import { useActionState, useState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@/components/submit-button"
import { Checkbox, Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { SegmentedControl } from "@/components/ui/segmented-control"
import {
  clearEmbeddingsAction,
  saveEmbeddingsAction,
  type EmbeddingsResult,
} from "@/lib/actions/embeddings"
import {
  defaultEmbedded,
  OPENAI_DEFAULT_MODEL,
  VOYAGE_DEFAULT_MODEL,
  type EmbeddedKinds,
  type EmbeddingProvider,
} from "@/lib/core/constants"
import type { EmbeddingsOverview } from "@/lib/core/embeddings/config"

const IDLE: EmbeddingsResult = { status: "idle" }

const PROVIDERS: Array<{ value: EmbeddingProvider; label: string }> = [
  { value: "voyage", label: "Voyage AI" },
  { value: "openai", label: "OpenAI-compatible" },
  { value: "endpoint", label: "Your own service" },
]

function Status({ state }: { state: EmbeddingsResult }) {
  return (
    <>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </>
  )
}

function providerName(overview: EmbeddingsOverview): string | null {
  const config = overview.config

  if (!config) return null
  if (config.provider === "voyage") return "Voyage AI"
  if (config.provider === "openai") {
    try {
      return new URL(config.url).host
    } catch {
      return "OpenAI-compatible"
    }
  }
  return (
    overview.endpoints.find((entry) => entry.id === config.serverId)?.name ??
    "your own service"
  )
}

function embeddedLine(embed: EmbeddedKinds): string {
  const kinds = [
    embed.tools ? "tools" : null,
    embed.skills ? "skills" : null,
    embed.memories ? "memories" : null,
  ].filter(Boolean)

  return kinds.join(", ")
}

/**
 * Settings → Search: an embeddings provider for search, so a task said in
 * other words than a tool's still finds it. Off, search goes by keywords;
 * on, by both, and by keywords alone whenever the provider fails. What it
 * may send is the owner's choice, tools alone by default for a provider
 * elsewhere.
 */
export function EmbeddingsCard({ overview }: { overview: EmbeddingsOverview }) {
  const config = overview.config
  const name = providerName(overview)

  return (
    <SettingsItem
      id="search"
      title="Search"
      icon={TextSearch}
      state={
        config
          ? `Embeddings by ${name} · ${embeddedLine(config.embed)}`
          : "Keywords only"
      }
      about={
        <>
          Assistants find your tools, skills and memories with search. By
          default it matches words. With an embeddings provider it also matches
          meaning, so &ldquo;launch a container&rdquo; finds a tool described as
          starting a service. Only what you tick below is sent to the provider,
          and search goes back to words whenever the provider is slow or down.
        </>
      }
    >
      <ProviderForm
        key={JSON.stringify(config)}
        overview={overview}
        configured={config !== null}
      />
      {config ? <ClearForm /> : null}
    </SettingsItem>
  )
}

function ProviderForm({
  overview,
  configured,
}: {
  overview: EmbeddingsOverview
  configured: boolean
}) {
  const [state, action] = useActionState(saveEmbeddingsAction, IDLE)
  const config = overview.config
  const [provider, setProvider] = useState<EmbeddingProvider>(
    config?.provider ?? "voyage",
  )
  const [url, setUrl] = useState(
    config?.provider === "openai" ? config.url : "",
  )
  const [embed, setEmbed] = useState<EmbeddedKinds>(
    config?.embed ?? defaultEmbedded(provider),
  )
  const [touched, setTouched] = useState(configured)

  const choose = (next: EmbeddingProvider) => {
    setProvider(next)
    if (!touched) setEmbed(defaultEmbedded(next, url))
  }
  const typeUrl = (next: string) => {
    setUrl(next)
    if (!touched) setEmbed(defaultEmbedded(provider, next))
  }
  const tick = (kind: keyof EmbeddedKinds, value: boolean) => {
    setTouched(true)
    setEmbed((current) => ({ ...current, [kind]: value }))
  }
  const model =
    config?.provider === provider
      ? config.model
      : provider === "voyage"
        ? VOYAGE_DEFAULT_MODEL
        : provider === "openai"
          ? OPENAI_DEFAULT_MODEL
          : ""
  const secretId =
    config && config.provider !== "endpoint" && config.provider === provider
      ? (config.secretId ?? "")
      : ""

  return (
    <form
      action={action}
      className="flex flex-col gap-4"
      aria-label="Embeddings provider"
    >
      <SegmentedControl
        name="provider"
        legend="Provider"
        options={PROVIDERS}
        value={provider}
        onValueChange={choose}
      />

      {provider === "voyage" ? (
        <p className="text-xs text-muted-foreground">
          Voyage AI&apos;s embeddings, with a free allowance. Make an API key on
          voyageai.com and add it under{" "}
          <Link href="/secrets" className="underline">
            Secrets
          </Link>
          .
        </p>
      ) : provider === "openai" ? (
        <p className="text-xs text-muted-foreground">
          Any address that answers OpenAI&apos;s /v1/embeddings: OpenAI itself,
          or Ollama, LocalAI or text-embeddings-inference on your own network.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          An API endpoint a service of yours registered. To run one in a click,
          add text-embeddings-inference from PCP&apos;s common items under{" "}
          <Link href="/settings/repositories" className="underline">
            Repositories
          </Link>
          , launch it on one of your SSH servers, then choose its endpoint here.
        </p>
      )}

      {provider === "openai" ? (
        <Field
          label="Address"
          htmlFor="embeddings-url"
          hint="Its base address, like https://api.openai.com/v1 or http://192.168.1.20:11434/v1."
        >
          <Input
            id="embeddings-url"
            name="url"
            value={url}
            onChange={(event) => typeUrl(event.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
        </Field>
      ) : null}

      {provider === "endpoint" ? (
        <Field label="API endpoint" htmlFor="embeddings-server">
          {overview.endpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You have no API endpoints yet.
            </p>
          ) : (
            <Select
              id="embeddings-server"
              name="serverId"
              defaultValue={
                config?.provider === "endpoint"
                  ? config.serverId
                  : (overview.endpoints.find((entry) => entry.service)?.id ??
                    "")
              }
            >
              <option value="">Choose an endpoint</option>
              {overview.endpoints.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {entry.service ? " (a service's)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}

      {provider !== "endpoint" ? (
        <Field
          label={provider === "voyage" ? "API key" : "API key (optional)"}
          htmlFor="embeddings-secret"
          hint="One of your secrets, sent as a bearer token. Never shown to an assistant."
        >
          <Select
            id="embeddings-secret"
            name="secretId"
            defaultValue={secretId}
          >
            <option value="">
              {provider === "voyage" ? "Choose a secret" : "None"}
            </option>
            {overview.secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field
        label="Model"
        htmlFor="embeddings-model"
        hint={
          provider === "endpoint"
            ? "Leave it empty for a service that serves one model."
            : undefined
        }
      >
        <Input
          id="embeddings-model"
          name="model"
          key={provider}
          defaultValue={model}
          autoComplete="off"
        />
      </Field>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="text-[15px] text-foreground">
          What the provider may read
        </legend>
        <p className="text-xs text-muted-foreground">
          Each is sent to the provider to be embedded, and the results kept
          encrypted in your vault. A provider elsewhere gets your tools&apos;
          names and descriptions only, unless you tick more.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            name="embedTools"
            checked={embed.tools}
            onChange={(event) => tick("tools", event.target.checked)}
          />
          Tools: their names and descriptions
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            name="embedSkills"
            checked={embed.skills}
            onChange={(event) => tick("skills", event.target.checked)}
          />
          Skills: their names and descriptions
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            name="embedMemories"
            checked={embed.memories}
            onChange={(event) => tick("memories", event.target.checked)}
          />
          Memories: their whole text
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" pendingText="Trying it…">
          {configured ? "Save" : "Turn on"}
        </SubmitButton>
        <Status state={state} />
      </div>
    </form>
  )
}

function ClearForm() {
  const [state, action] = useActionState(clearEmbeddingsAction, IDLE)

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <SubmitButton variant="plain" pendingText="Turning off…">
        Turn off, keywords only
      </SubmitButton>
      <Status state={state} />
    </form>
  )
}
