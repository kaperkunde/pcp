"use client"

import { ChevronRight, RefreshCw, Search } from "lucide-react"
import { useId, useOptimistic, useState, useTransition } from "react"

import { AllTokensCheckbox } from "@/components/all-tokens-checkbox"
import { FormError, FormNote } from "@/components/form-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconTile, serverKindLabel } from "@/components/ui/icon-tile"
import { Select } from "@/components/ui/input"
import { List, ListSection } from "@/components/ui/list"
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control"
import { refreshToolsAction } from "@/lib/actions/servers"
import {
  setServerToolAccessAction,
  setToolAccessAction,
  setToolAccessSharedAction,
} from "@/lib/actions/tokens"
import {
  TOOL_ACCESS_LABELS,
  TOOL_ACCESS_LEVELS,
  type ToolAccess,
} from "@/lib/core/constants"
import type { ServerKind } from "@/lib/core/servers"
import type { TokenServerAccess, TokenToolAccess } from "@/lib/core/tool-access"
import { cn } from "@/lib/utils"

/** A tool's level as three segments: Allow, Ask, Block. */
export const LEVEL_OPTIONS: ReadonlyArray<SegmentedOption<ToolAccess>> = [
  { value: "allowed", label: "Allow", tone: "allow" },
  { value: "ask", label: "Ask" },
  { value: "blocked", label: "Block", tone: "block" },
]

type Filter = "all" | ToolAccess

/**
 * What an assistant using this token may run, per server: a row with how
 * many tools it may run, ask about and is blocked from, and a level for all
 * of them at once, unfolding to one level per tool. A change here is the
 * token's own level, which wins over the one for all tokens.
 *
 * `advanced` adds what the owner looks for now and then: a search and a
 * filter over every tool, the All tokens box on each, and reading a
 * server's tools again.
 */
export function TokenTools({
  tokenId,
  access,
  kinds,
  locked,
  advanced = false,
}: {
  tokenId: string
  access: TokenServerAccess[]
  /** Each server's kind, by id, for its icon and the line under its name. */
  kinds: Record<string, ServerKind | undefined>
  locked: boolean
  advanced?: boolean
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const total = access.reduce((sum, server) => sum + server.tools.length, 0)
  const needle = query.trim().toLowerCase()
  const narrowed = advanced && (needle !== "" || filter !== "all")

  function shown(server: TokenServerAccess): TokenToolAccess[] {
    if (!narrowed) return server.tools

    const serverMatches =
      server.name.toLowerCase().includes(needle) || server.slug.includes(needle)

    return server.tools.filter(
      (tool) =>
        (filter === "all" || tool.access === filter) &&
        (needle === "" ||
          serverMatches ||
          tool.name.toLowerCase().includes(needle) ||
          (tool.title ?? "").toLowerCase().includes(needle)),
    )
  }

  const groups = access
    .map((server) => ({ server, tools: shown(server) }))
    .filter(({ tools }) => !narrowed || tools.length > 0)

  return (
    <ListSection
      title={advanced ? "Tool levels" : "Tools"}
      description={
        advanced
          ? "Tick All tokens to make a level the one every token follows unless it has its own. Blocked tools are hidden from the assistant."
          : "A tool you have not decided on asks you the first time, and your answer can decide it for good. Blocked tools are hidden from the assistant."
      }
      action={
        advanced && total > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 w-56 items-center gap-2 rounded-[9px] bg-field px-3 text-muted-foreground focus-within:ring-3 focus-within:ring-ring/40">
              <Search aria-hidden className="size-4 shrink-0" />
              <span className="sr-only">Search tools</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${total} ${total === 1 ? "tool" : "tools"}`}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <SegmentedControl<Filter>
              name="tool-filter"
              legend="Show"
              size="sm"
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "allowed", label: "Allowed" },
                { value: "ask", label: "Ask" },
                { value: "blocked", label: "Blocked" },
              ]}
            />
          </div>
        ) : null
      }
    >
      <List>
        {access.length === 0 ? (
          <p className="px-4 py-4 text-muted-foreground">
            It reaches no servers yet.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-4 py-4 text-muted-foreground">No tools match.</p>
        ) : (
          groups.map(({ server, tools }) => (
            <ServerTools
              key={server.id}
              tokenId={tokenId}
              server={server}
              tools={tools}
              kind={kinds[server.id]}
              locked={locked}
              advanced={advanced}
              forceOpen={narrowed}
            />
          ))
        )}
      </List>
    </ListSection>
  )
}

/** "6 allowed · 36 ask first", or "All 113 ask first". */
function toolsSummary(tools: TokenToolAccess[]): string {
  if (tools.length === 0) {
    return "No tools known yet"
  }

  const words: Record<ToolAccess, string> = {
    allowed: "allowed",
    ask: "ask first",
    blocked: "blocked",
  }
  const counts = TOOL_ACCESS_LEVELS.map(
    (level) =>
      [level, tools.filter((tool) => tool.access === level).length] as const,
  ).filter(([, count]) => count > 0)

  if (counts.length === 1) {
    const [level] = counts[0]!

    return tools.length === 1
      ? `1 tool, ${level === "ask" ? "asks first" : words[level]}`
      : `All ${tools.length} ${words[level]}`
  }

  return counts.map(([level, count]) => `${count} ${words[level]}`).join(" · ")
}

function ServerTools({
  tokenId,
  server,
  tools,
  kind,
  locked,
  advanced,
  forceOpen,
}: {
  tokenId: string
  server: TokenServerAccess
  tools: TokenToolAccess[]
  kind: ServerKind | undefined
  locked: boolean
  advanced: boolean
  forceOpen: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [refreshing, startRefresh] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // Folded until asked for: a server can bring hundreds of tools, and the
  // page should show every server at a glance.
  const [open, setOpen] = useState(false)
  const listId = useId()
  const unfolded = open || forceOpen

  function setAll(level: ToolAccess) {
    if (
      !window.confirm(
        `Set all ${server.tools.length} tools on ${server.name} to ${TOOL_ACCESS_LABELS[level]} for this token?`,
      )
    ) {
      return
    }

    startTransition(async () => {
      const result = await setServerToolAccessAction(tokenId, server.id, level)
      setError(result.status === "error" ? result.error : null)
      setNote(null)
    })
  }

  // Servers add and drop tools as they please: read the list again so a new
  // one can be decided here before an assistant asks for it.
  function refresh() {
    startRefresh(async () => {
      const result = await refreshToolsAction(server.id)
      setError(result.status === "error" ? result.error : null)
      setNote(result.status === "ok" ? (result.message ?? null) : null)
    })
  }

  return (
    <section aria-label={server.name} className="flex flex-col">
      <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 bg-[#1c2129] px-4 py-2.5">
        <button
          type="button"
          aria-expanded={unfolded}
          aria-controls={listId}
          disabled={forceOpen}
          onClick={() => setOpen((value) => !value)}
          className="-ml-1 flex min-w-0 flex-1 basis-56 cursor-pointer items-center gap-3 rounded-md px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              unfolded && "rotate-90",
            )}
          />
          {advanced ? <IconTile kind={kind ?? "mcp"} size="sm" /> : null}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold break-words">{server.name}</span>
            <span className="text-xs text-muted-foreground">
              <code className="text-xs">{server.slug}</code>
              {advanced ? ` · ${serverKindLabel(kind ?? "mcp")}` : null}
              {" · "}
              {toolsSummary(server.tools)}
            </span>
          </span>
        </button>
        {server.enabled ? null : (
          <Badge variant="secondary">Switched off</Badge>
        )}
        {advanced && server.refreshable && !locked ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw
              aria-hidden
              className={cn(refreshing && "animate-spin")}
            />
            Read tools again
            <span className="sr-only"> on {server.slug}</span>
          </Button>
        ) : null}
        {server.tools.length > 0 && !locked ? (
          <Select
            aria-label={`All tools on ${server.slug}`}
            value=""
            disabled={pending}
            onChange={(event) => {
              const level = event.target.value as ToolAccess | ""
              if (level) setAll(level)
            }}
            className="h-8 w-auto text-[13px]"
          >
            <option value="">{pending ? "Saving…" : "Set all…"}</option>
            {TOOL_ACCESS_LEVELS.map((level) => (
              <option key={level} value={level}>
                {TOOL_ACCESS_LABELS[level]}
              </option>
            ))}
          </Select>
        ) : null}
        <FormError error={error} className="basis-full" />
        <FormNote message={note} className="basis-full" />
      </div>
      <div id={listId} hidden={!unfolded}>
        {unfolded ? (
          tools.length === 0 ? (
            <p className="border-t border-separator px-4 py-3 pl-11 text-[13px] text-muted-foreground">
              No tools known yet. Connect the server, or read its tools again.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-separator border-t border-separator p-0">
              {tools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tokenId={tokenId}
                  serverId={server.id}
                  slug={server.slug}
                  tool={tool}
                  locked={locked}
                  advanced={advanced}
                />
              ))}
            </ul>
          )
        ) : null}
      </div>
    </section>
  )
}

function ToolRow({
  tokenId,
  serverId,
  slug,
  tool,
  locked,
  advanced,
}: {
  tokenId: string
  serverId: string
  slug: string
  tool: TokenToolAccess
  locked: boolean
  advanced: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [shown, setShown] = useOptimistic({
    access: tool.access,
    shared: tool.own === null && tool.shared !== null,
  })
  const [error, setError] = useState<string | null>(null)

  // A change here is this token's own level, which wins over all tokens'.
  function change(access: ToolAccess) {
    startTransition(async () => {
      setShown({ access, shared: false })
      const result = await setToolAccessAction(
        tokenId,
        serverId,
        tool.name,
        access,
      )
      setError(result.status === "error" ? result.error : null)
    })
  }

  function share(shared: boolean) {
    startTransition(async () => {
      setShown({ ...shown, shared })
      const result = await setToolAccessSharedAction(
        tokenId,
        serverId,
        tool.name,
        shared,
      )
      setError(result.status === "error" ? result.error : null)
    })
  }

  return (
    <li className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 py-2 pr-4 pl-11">
      <span className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2 gap-y-0.5">
        <code className="text-[13px] break-all">{tool.name}</code>
        {tool.title ? (
          <span className="text-xs text-muted-foreground">{tool.title}</span>
        ) : null}
        {!advanced && shown.shared ? (
          <span className="text-xs text-muted-foreground">from All tokens</span>
        ) : null}
      </span>
      <SegmentedControl<ToolAccess>
        name={`${advanced ? "advanced" : "tool"}:${slug}/${tool.name}`}
        legend={`Access to ${slug}/${tool.name}`}
        size="sm"
        options={LEVEL_OPTIONS}
        value={shown.access}
        onValueChange={change}
        disabled={locked || pending}
      />
      {advanced ? (
        <AllTokensCheckbox
          checked={shown.shared}
          disabled={locked || pending}
          label={`All tokens for ${slug}/${tool.name}`}
          sharedLevel={tool.shared ? TOOL_ACCESS_LABELS[tool.shared] : null}
          onChange={share}
        />
      ) : null}
      <FormError error={error} className="basis-full" />
    </li>
  )
}
