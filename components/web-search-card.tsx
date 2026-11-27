"use client"

import { Globe } from "lucide-react"
import Link from "next/link"
import { useActionState, useState } from "react"

import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { Input, Select } from "@kaperkunde/ui/input"
import { Field } from "@kaperkunde/ui/label"
import { SegmentedControl } from "@kaperkunde/ui/segmented-control"
import {
  clearWebSearchAction,
  saveWebSearchAction,
  type WebSearchResult,
} from "@/lib/actions/web-search"
import type { WebSearchOverview } from "@/lib/core/websearch/config"
import {
  PROVIDER_INFO,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from "@/lib/core/websearch/providers"

const IDLE: WebSearchResult = { status: "idle" }

const OPTIONS = WEB_SEARCH_PROVIDERS.map((id) => ({
  value: id,
  label: PROVIDER_INFO[id].title.replace(" (your own)", ""),
}))

function Status({ state }: { state: WebSearchResult }) {
  return (
    <>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </>
  )
}

/**
 * Settings → Web search: the provider behind web_search. None is chosen
 * until the owner does it: PCP has no search of its own and none that is
 * free for programs to use without terms of their own.
 */
export function WebSearchCard({ overview }: { overview: WebSearchOverview }) {
  const config = overview.config

  return (
    <SettingsItem
      id="web-search"
      title="Web search"
      icon={Globe}
      state={config ? PROVIDER_INFO[config.provider].title : "Not set up"}
      about={
        <>
          web_search lets an assistant (or a program of its) search the web
          through PCP, for the tokens you tick &ldquo;Search the web&rdquo; on.
          PCP has no search of its own: choose a provider and give it your own
          key, or run a search server yourself. Searches are paced and cooled
          down like any site, and the query is never written to the request log.
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
  overview: WebSearchOverview
  configured: boolean
}) {
  const [state, action] = useActionState(saveWebSearchAction, IDLE)
  const config = overview.config
  const [provider, setProvider] = useState<WebSearchProvider>(
    config?.provider ?? "brave",
  )
  const info = PROVIDER_INFO[provider]
  const secretId = config?.provider === provider ? (config.secretId ?? "") : ""

  return (
    <form
      action={action}
      className="flex flex-col gap-4"
      aria-label="Web search provider"
    >
      <SegmentedControl
        name="provider"
        legend="Provider"
        options={OPTIONS}
        value={provider}
        onValueChange={setProvider}
      />

      <p className="text-xs text-muted-foreground">
        {info.about}
        {info.keyAt ? ` Make a key at ${info.keyAt} and add it under ` : " "}
        {info.keyAt ? (
          <>
            <Link href="/secrets" className="underline">
              Secrets
            </Link>
            .
          </>
        ) : null}
      </p>

      {info.ownAddress ? (
        <Field
          label="Address"
          htmlFor="web-search-url"
          hint="Your search server's address, like https://search.example.com or http://192.168.1.20:8080."
        >
          <Input
            id="web-search-url"
            name="url"
            defaultValue={
              config?.provider === provider ? (config.url ?? "") : ""
            }
            placeholder="https://search.example.com"
            autoComplete="off"
          />
        </Field>
      ) : null}

      <Field
        label={info.keyOptional ? "API key (optional)" : "API key"}
        htmlFor="web-search-secret"
        hint="One of your secrets, sent to the provider and nowhere else. Never shown to an assistant."
      >
        <Select
          id="web-search-secret"
          name="secretId"
          key={provider}
          defaultValue={secretId}
        >
          <option value="">
            {info.keyOptional ? "None" : "Choose a secret"}
          </option>
          {overview.secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name}
            </option>
          ))}
        </Select>
      </Field>

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
  const [state, action] = useActionState(clearWebSearchAction, IDLE)

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <SubmitButton variant="plain" pendingText="Turning off…">
        Turn off web search
      </SubmitButton>
      <Status state={state} />
    </form>
  )
}
