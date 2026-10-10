"use client"

import { useActionState, useOptimistic, useState, useTransition } from "react"

import { AllTokensCheckbox } from "@/components/all-tokens-checkbox"
import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { LEVEL_OPTIONS } from "@/components/token-tools"
import { Button } from "@/components/ui/button"
import { Checkbox, Input, Select } from "@/components/ui/input"
import { List, ListSection } from "@/components/ui/list"
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control"
import { SwitchRow } from "@/components/ui/switch"
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
  FETCH_SITE_LABELS,
  FETCH_SITE_LEVELS,
  TOOL_ACCESS_LABELS,
  type FetchSiteLevel,
  type ToolAccess,
} from "@/lib/core/constants"
import type {
  FetchMethodView,
  FetchPrivateView,
  FetchSiteView,
  TokenFetchRules,
} from "@/lib/core/web-fetch"

/** A site's level: by its method, or one of the tool levels. */
const SITE_OPTIONS: ReadonlyArray<SegmentedOption<FetchSiteLevel>> = [
  { value: "default", label: "By method" },
  ...(LEVEL_OPTIONS as ReadonlyArray<SegmentedOption<FetchSiteLevel>>),
]

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
  webFetch = true,
  browser = false,
}: {
  tokenId: string
  rules: TokenFetchRules
  locked: boolean
  /** The token fetches web pages (web_fetch). */
  webFetch?: boolean
  /** The token reaches the browser, which follows these sites too. */
  browser?: boolean
}) {
  return (
    <ListSection
      id="web-pages"
      className="scroll-mt-8"
      title={
        webFetch
          ? browser
            ? "Web pages and the browser"
            : "Web pages"
          : "Browser sites"
      }
      description={
        <>
          {webFetch
            ? "An assistant with this token can fetch web pages through PCP, with none of your secrets, and from your own network only if you allow it below. "
            : "An assistant with this token can open pages in PCP's browser, from your own network only if you allow it below. "}
          A site&apos;s own level decides every request to it; a site set to By
          method gets the level of the request&apos;s method. Each site an
          assistant reaches for shows up here the first time.
          {browser
            ? " The browser opens a page where a GET request may go, and asks you first where one would ask."
            : null}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Group
          title="Methods"
          caption="For every site set to By method, including one an assistant has not reached for yet."
        >
          <List as="ul">
            {rules.methods.map((method) => (
              <MethodRow
                key={method.group}
                tokenId={tokenId}
                method={method}
                locked={locked}
              />
            ))}
          </List>
        </Group>

        <Group
          title={`Sites${rules.sites.length > 0 ? ` (${rules.sites.length})` : ""}`}
        >
          <List as="ul">
            {rules.sites.length === 0 ? (
              <li className="px-4 py-3.5 text-muted-foreground">
                No sites yet. The first time an assistant reaches for one, it
                shows up here; you can also add one.
              </li>
            ) : (
              rules.sites.map((site) => (
                <SiteRow
                  key={site.host}
                  tokenId={tokenId}
                  site={site}
                  locked={locked}
                />
              ))
            )}
            {locked ? null : (
              <li>
                <AddSiteForm tokenId={tokenId} />
              </li>
            )}
          </List>
        </Group>

        <Group title="Your own network">
          <List>
            <PrivateRow
              tokenId={tokenId}
              rule={rules.privateAddresses}
              locked={locked}
            />
          </List>
        </Group>
      </div>
    </ListSection>
  )
}

function Group({
  title,
  caption,
  children,
}: {
  title: string
  caption?: string
  children: React.ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 px-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {caption ? (
          <p className="text-xs text-muted-foreground">{caption}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

const rowClassName =
  "flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"

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
    <li className={rowClassName}>
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <code className="text-[13px]">{label}</code>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      <SegmentedControl<ToolAccess>
        name={`fetch-method:${method.group}`}
        legend={`Web fetch ${label}`}
        size="sm"
        options={LEVEL_OPTIONS}
        value={shown.access}
        onValueChange={change}
        disabled={locked || pending}
      />
      <AllTokensCheckbox
        checked={shown.shared}
        disabled={locked || pending}
        label={`All tokens for ${label}`}
        sharedLevel={method.shared ? TOOL_ACCESS_LABELS[method.shared] : null}
        onChange={share}
      />
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

  function change(allowed: boolean) {
    const access = allowed ? "allowed" : "blocked"

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
    <>
      <SwitchRow
        id={`fetch-private-${tokenId}`}
        className="flex-wrap"
        label="Private addresses"
        description="Loopback, private and link-local addresses: a device at home, a service on this machine. Off unless you turn it on; an assistant cannot ask for it. PCP's own address is never reached."
        checked={shown.access === "allowed"}
        disabled={locked || pending}
        onChange={(event) => change(event.target.checked)}
        trailing={
          <AllTokensCheckbox
            checked={shown.shared}
            disabled={locked || pending}
            label="All tokens for private addresses"
            sharedLevel={rule.shared ? FETCH_PRIVATE_LABELS[rule.shared] : null}
            onChange={share}
          />
        }
      />
      {error ? <FormError error={error} className="px-4 py-2" /> : null}
    </>
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
    <li className={rowClassName} aria-label={site.host}>
      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="text-[15px] break-all">{site.host}</span>
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
      </span>
      <SegmentedControl<FetchSiteLevel>
        name={`fetch-site:${site.host}`}
        legend={`Web fetch ${site.host}`}
        size="sm"
        options={SITE_OPTIONS}
        value={shown.level}
        onValueChange={change}
        disabled={locked || pending}
      />
      <AllTokensCheckbox
        checked={shown.shared}
        disabled={locked || pending}
        label={`All tokens for ${site.host}`}
        sharedLevel={site.shared ? FETCH_SITE_LABELS[site.shared] : null}
        onChange={share}
      />
      {locked ? null : (
        <Button
          type="button"
          variant="plain"
          size="sm"
          disabled={pending}
          onClick={remove}
          aria-label={`Remove ${site.host}`}
        >
          Remove
        </Button>
      )}
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
    <form action={action} className={rowClassName}>
      <input type="hidden" name="tokenId" value={tokenId} />
      <label htmlFor={`fetch-site-${tokenId}`} className="sr-only">
        Add a site
      </label>
      <Input
        id={`fetch-site-${tokenId}`}
        name="site"
        required
        maxLength={300}
        autoComplete="off"
        placeholder="Add a site, like example.com"
        className="h-9 min-w-0 flex-1 basis-56"
      />
      <Select
        aria-label="Level"
        name="level"
        defaultValue="allowed"
        className="h-9 w-auto text-[13px]"
      >
        {FETCH_SITE_LEVELS.map((level) => (
          <option key={level} value={level}>
            {FETCH_SITE_LABELS[level]}
          </option>
        ))}
      </Select>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox name="shared" />
        For all tokens
      </label>
      <SubmitButton variant="secondary" size="sm" pendingText="Adding…">
        Add site
      </SubmitButton>
      <FormError
        error={state.status === "error" ? state.error : null}
        className="basis-full"
      />
      <FormNote
        message={state.status === "ok" ? state.message : null}
        className="basis-full"
      />
    </form>
  )
}
