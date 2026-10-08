import type { Metadata } from "next"
import Form from "next/form"
import Link from "next/link"

import { LocalDate } from "@/components/local-date"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button, ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  activityLog,
  readActivityQuery,
  type ActivityEntry,
  type RequestState,
} from "@/lib/core/activity"
import { MAX_LOG_SEARCH_CHARS } from "@/lib/core/log-limits"
import type { LogQuery } from "@/lib/core/request-log"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Log" }

const LINK = "text-primary underline-offset-4 hover:underline"

const REQUEST_STATES: Record<RequestState, string> = {
  waiting: "Waiting for you",
  running: "Running",
  allowed: "You allowed it",
  failed: "Allowed, failed",
  declined: "You said no",
  expired: "Expired",
}

/** The page's address for a query, with `before` for another page. */
function href(query: LogQuery, before?: string): string {
  const params = new URLSearchParams()

  if (query.tokenId) params.set("token", query.tokenId)
  if (query.outcome) params.set("outcome", query.outcome)
  if (query.text) params.set("q", query.text)
  if (before) params.set("before", before)

  const search = params.toString()
  return search ? `/log?${search}` : "/log"
}

export default async function LogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const query = readActivityQuery(await searchParams)
  const { entries, next, tokens } = await activityLog(ctx, query)
  const filtered = !!(query.tokenId || query.outcome || query.text)

  return (
    <>
      <PageHeader
        title="Log"
        description={
          <>
            What assistants did with their API tokens: every call to PCP, which
            tool it was, how long it took and how it ended. Never what they sent
            or what came back. Days older than you keep are removed by the{" "}
            <Link href="/settings#cleanup" className={LINK}>
              cleanup
            </Link>
            .
          </>
        }
      />

      <Form
        action="/log"
        className="grid gap-4 sm:grid-cols-[1fr_1fr_1.5fr_auto] sm:items-end"
        aria-label="Filter the log"
      >
        <Field label="Token" htmlFor="log-token">
          <Select
            id="log-token"
            name="token"
            defaultValue={query.tokenId ?? ""}
          >
            <option value="">All tokens</option>
            {tokens.map((token) => (
              <option key={token.id} value={token.id}>
                {token.name}
                {token.revoked ? " (revoked)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Outcome" htmlFor="log-outcome">
          <Select
            id="log-outcome"
            name="outcome"
            defaultValue={query.outcome ?? ""}
          >
            <option value="">Any</option>
            <option value="ok">Done</option>
            <option value="error">Failed</option>
            <option value="asked">Asked you</option>
          </Select>
        </Field>
        <Field label="Tool or server" htmlFor="log-q">
          <Input
            id="log-q"
            name="q"
            type="search"
            defaultValue={query.text ?? ""}
            maxLength={MAX_LOG_SEARCH_CHARS}
            placeholder="call_tool, gmail, web_fetch…"
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="outline">
            Filter
          </Button>
          {filtered ? (
            <ButtonLink href="/log" variant="ghost">
              Clear
            </ButtonLink>
          ) : null}
        </div>
      </Form>

      {entries.length === 0 ? (
        <Card className="items-start">
          <p className="text-muted-foreground">
            {next
              ? "Nothing matched in the lines read so far. Look further back for more."
              : filtered
                ? "Nothing in the log matches."
                : "Nothing in the log yet. Calls appear here as soon as an assistant uses one of your API tokens."}
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10">
          {entries.map((entry) => (
            <LogLine key={entry.id} entry={entry} />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {query.cursor ? (
          <ButtonLink href={href(query)} variant="outline" size="sm">
            Newest
          </ButtonLink>
        ) : null}
        {next ? (
          <ButtonLink href={href(query, next)} variant="outline" size="sm">
            Older
          </ButtonLink>
        ) : null}
      </div>
    </>
  )
}

function LogLine({ entry }: { entry: ActivityEntry }) {
  return (
    <li
      className="flex flex-col gap-1 px-4 py-3 text-sm"
      data-testid="log-line"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-medium">{entry.tool}</code>
          {entry.server ? (
            <code className="text-muted-foreground">
              {entry.server}
              {entry.upstreamTool ? `/${entry.upstreamTool}` : ""}
            </code>
          ) : null}
        </div>
        <Outcome entry={entry} />
      </div>
      <p className="text-xs text-muted-foreground">
        <LocalDate value={entry.ts} /> ·{" "}
        {entry.tokenName ? (
          <Link href={`/tokens/${entry.tokenId}`} className={LINK}>
            {entry.tokenName}
          </Link>
        ) : (
          "a deleted token"
        )}{" "}
        · {entry.ms.toLocaleString("en")} ms
      </p>
      {entry.outcome === "error" && entry.error ? (
        <p className="text-xs text-destructive">{entry.error}</p>
      ) : null}
    </li>
  )
}

function Outcome({ entry }: { entry: ActivityEntry }) {
  if (entry.outcome === "error") {
    return <Badge variant="destructive">Failed</Badge>
  }

  if (entry.outcome === "ok") {
    return <Badge>Done</Badge>
  }

  const label = entry.requestState
    ? REQUEST_STATES[entry.requestState]
    : "Asked you"
  const badge = (
    <Badge variant={entry.requestState === "waiting" ? "warning" : "outline"}>
      {label}
    </Badge>
  )

  return entry.request && entry.requestState ? (
    <Link
      href={`/permissions/${entry.request}`}
      aria-label={`${label}: open the request`}
    >
      {badge}
    </Link>
  ) : (
    badge
  )
}
