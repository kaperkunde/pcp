"use client"

import { useActionState, useOptimistic, useState, useTransition } from "react"

import { AllTokensCheckbox } from "@/components/all-tokens-checkbox"
import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox, Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  addFetchSiteAction,
  removeFetchSiteAction,
  setFetchMethodAction,
  setFetchPrivateAction,
  setFetchRuleSharedAction,
  setFetchSiteAction,
  type AddFetchSiteResult,
} from "@/lib/actions/web-fetch"
import {
  FETCH_METHOD_LABELS,
  FETCH_PRIVATE_LABELS,
  FETCH_PRIVATE_LEVELS,
  FETCH_SITE_LABELS,
  FETCH_SITE_LEVELS,
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  type FetchSiteLevel,
  type ToolAccess,
} from "@/lib/core/constants"
import type {
  FetchMethodView,
  FetchPrivateLevel,
  FetchPrivateView,
  FetchSiteView,
  TokenFetchRules,
} from "@/lib/core/web-fetch"
import { cn } from "@/lib/utils"

/**
 * What an assistant with this token may fetch through web_fetch: a level
 * per method, then every site it reached for (and the ones you added), each
 * with a level of its own or following the methods, and whether it reaches
 * private addresses (the browser follows the same lines). Any line can be
 * made the one for all tokens.
 */
export function WebFetchCard({
  tokenId,
  rules,
  locked,
}: {
  tokenId: string
  rules: TokenFetchRules
  locked: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Web fetch</CardTitle>
        <CardDescription>
          An assistant with this token can fetch web pages through PCP, with
          none of your secrets, and from your own network only if you allow it
          below. A site&apos;s own setting decides every request to it; a site
          that uses the method settings gets the level of the request&apos;s
          method. Each site an assistant reaches for shows up here the first
          time. The browser, when this token can use it, follows the same sites
          and the GET setting.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section aria-label="Methods" className="flex flex-col gap-2">
          <h3 className="font-medium">Methods</h3>
          <p className="text-xs text-muted-foreground">
            For every site that uses the method settings, including one an
            assistant has not reached for yet.
          </p>
          <ul className="flex flex-col divide-y divide-border">
            {rules.methods.map((method) => (
              <MethodRow
                key={method.group}
                tokenId={tokenId}
                method={method}
                locked={locked}
              />
            ))}
          </ul>
        </section>
        <section aria-label="Private addresses" className="flex flex-col gap-2">
          <h3 className="font-medium">Private addresses</h3>
          <PrivateRow
            tokenId={tokenId}
            rule={rules.privateAddresses}
            locked={locked}
          />
        </section>
        <section aria-label="Sites" className="flex flex-col gap-2">
          <h3 className="font-medium">Sites</h3>
          {rules.sites.length === 0 ? (
            <p className="text-muted-foreground">
              No sites yet. The first time an assistant fetches from one, it
              shows up here; you can also add one below.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {rules.sites.map((site) => (
                <SiteRow
                  key={site.host}
                  tokenId={tokenId}
                  site={site}
                  locked={locked}
                />
              ))}
            </ul>
          )}
          {locked ? null : <AddSiteForm tokenId={tokenId} />}
        </section>
      </CardContent>
    </Card>
  )
}

function levelClass(level: string) {
  return cn(
    "h-8 w-auto",
    level === "blocked" && "text-destructive",
    level === "allowed" && "text-primary",
  )
}

function MethodRow({
  tokenId,
  method,
  locked,
}: {
  tokenId: string
  method: FetchMethodView
  locked: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useOptimistic({
    access: method.access,
    shared: method.own === null && method.shared !== null,
  })
  const [error, setError] = useState<string | null>(null)
  const { label, hint } = FETCH_METHOD_LABELS[method.group]

  function change(access: ToolAccess) {
    startTransition(async () => {
      setShown({ access, shared: false })
      const result = await setFetchMethodAction(tokenId, method.group, access)
      setError(result.status === "error" ? result.error : null)
    })
  }

  function share(shared: boolean) {
    startTransition(async () => {
      setShown({ ...shown, shared })
      const result = await setFetchRuleSharedAction(
        tokenId,
        "method",
        method.group,
        shared,
      )
      setError(result.status === "error" ? result.error : null)
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="text-sm">{label}</code>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <AllTokensCheckbox
          checked={shown.shared}
          disabled={locked || pending}
          label={`All tokens for ${label}`}
          sharedLevel={method.shared ? TOOL_ACCESS_LABELS[method.shared] : null}
          onChange={share}
        />
        <Select
          aria-label={`Web fetch ${label}`}
          value={shown.access}
          disabled={locked || pending}
          onChange={(event) => change(event.target.value as ToolAccess)}
          className={levelClass(shown.access)}
        >
          {TOOL_ACCESS_LEVELS.map((level) => (
            <option key={level} value={level}>
              {TOOL_ACCESS_LABELS[level]}
            </option>
          ))}
        </Select>
      </div>
      <FormError error={error} className="basis-full" />
    </li>
  )
}

function PrivateRow({
  tokenId,
  rule,
  locked,
}: {
  tokenId: string
  rule: FetchPrivateView
  locked: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useOptimistic({
    access: rule.access,
    shared: rule.own === null && rule.shared !== null,
  })
  const [error, setError] = useState<string | null>(null)

  function change(access: FetchPrivateLevel) {
    startTransition(async () => {
      setShown({ access, shared: false })
      const result = await setFetchPrivateAction(tokenId, access)
      setError(result.status === "error" ? result.error : null)
    })
  }

  function share(shared: boolean) {
    startTransition(async () => {
      setShown({ ...shown, shared })
      const result = await setFetchRuleSharedAction(
        tokenId,
        "private",
        "private",
        shared,
      )
      setError(result.status === "error" ? result.error : null)
    })
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 basis-80 grow text-xs text-muted-foreground">
        Loopback, private and link-local addresses: a device at home, a service
        on this machine. Blocked unless you allow it; an assistant cannot ask
        for it. PCP&apos;s own address is never reached.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <AllTokensCheckbox
          checked={shown.shared}
          disabled={locked || pending}
          label="All tokens for private addresses"
          sharedLevel={rule.shared ? FETCH_PRIVATE_LABELS[rule.shared] : null}
          onChange={share}
        />
        <Select
          aria-label="Web fetch private addresses"
          value={shown.access}
          disabled={locked || pending}
          onChange={(event) => change(event.target.value as FetchPrivateLevel)}
          className={levelClass(shown.access)}
        >
          {FETCH_PRIVATE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {FETCH_PRIVATE_LABELS[level]}
            </option>
          ))}
        </Select>
      </div>
      <FormError error={error} className="basis-full" />
    </div>
  )
}

function SiteRow({
  tokenId,
  site,
  locked,
}: {
  tokenId: string
  site: FetchSiteView
  locked: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useOptimistic({
    level: site.level,
    shared: site.own === null && site.shared !== null,
  })
  const [error, setError] = useState<string | null>(null)

  function change(level: FetchSiteLevel) {
    startTransition(async () => {
      setShown({ level, shared: false })
      const result = await setFetchSiteAction(tokenId, site.host, level)
      setError(result.status === "error" ? result.error : null)
    })
  }

  function share(shared: boolean) {
    startTransition(async () => {
      setShown({ ...shown, shared })
      const result = await setFetchRuleSharedAction(
        tokenId,
        "site",
        site.host,
        shared,
      )
      setError(result.status === "error" ? result.error : null)
    })
  }

  function remove() {
    if (
      shown.shared &&
      !window.confirm(
        `${site.host} is set for all tokens. Remove it for every token?`,
      )
    ) {
      return
    }

    startTransition(async () => {
      const result = await removeFetchSiteAction(tokenId, site.host)
      setError(result.status === "error" ? result.error : null)
    })
  }

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 py-2"
      aria-label={site.host}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <code className="text-sm break-all">{site.host}</code>
        <span className="text-xs text-muted-foreground">
          {site.addedBy === "owner" ? "Added by you" : "Added by an assistant"}
          {" · "}
          {site.lastFetchedAt ? (
            <>
              last fetched <LocalDate value={site.lastFetchedAt} />
            </>
          ) : (
            "not fetched yet"
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <AllTokensCheckbox
          checked={shown.shared}
          disabled={locked || pending}
          label={`All tokens for ${site.host}`}
          sharedLevel={site.shared ? FETCH_SITE_LABELS[site.shared] : null}
          onChange={share}
        />
        <Select
          aria-label={`Web fetch ${site.host}`}
          value={shown.level}
          disabled={locked || pending}
          onChange={(event) => change(event.target.value as FetchSiteLevel)}
          className={levelClass(shown.level)}
        >
          {FETCH_SITE_LEVELS.map((level) => (
            <option key={level} value={level}>
              {FETCH_SITE_LABELS[level]}
            </option>
          ))}
        </Select>
        {locked ? null : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={remove}
            aria-label={`Remove ${site.host}`}
          >
            Remove
          </Button>
        )}
      </div>
      <FormError error={error} className="basis-full" />
    </li>
  )
}

function AddSiteForm({ tokenId }: { tokenId: string }) {
  const [state, action] = useActionState<AddFetchSiteResult, FormData>(
    addFetchSiteAction,
    { status: "idle" },
  )

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <input type="hidden" name="tokenId" value={tokenId} />
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Add a site" htmlFor="fetch-site">
          <Input
            id="fetch-site"
            name="site"
            required
            maxLength={300}
            autoComplete="off"
            placeholder="example.com"
          />
        </Field>
        <Field label="Level" htmlFor="fetch-site-level">
          <Select
            id="fetch-site-level"
            name="level"
            defaultValue="allowed"
            className="w-auto"
          >
            {FETCH_SITE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {FETCH_SITE_LABELS[level]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox name="shared" />
        For all tokens
      </label>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
      <div>
        <SubmitButton pendingText="Adding…">Add site</SubmitButton>
      </div>
    </form>
  )
}
